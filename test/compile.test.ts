import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileApp, createSession } from "../src/compile/index.js";
import type { NovaConfig } from "../src/compile/config.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturesDir = here("./fixtures/");

const dirs: string[] = [];
function fixtureCopy(): string {
  // Created inside the repo (under test/fixtures/) rather than the OS tmpdir. compileApp
  // typechecks its emitted output, and the emitted pages.tsx imports "react" — Node
  // resolves that by walking up from the file's location, and it would never reach this
  // repo's node_modules starting from /tmp. cpSync-ing the whole "fixtures" directory
  // recursively into a subdirectory of itself throws (Node refuses to copy a directory
  // into its own subtree), so each fixture subtree is copied individually instead of one
  // recursive copy of "fixtures" — same idea as the targeted copies in test/emit.test.ts.
  const root = mkdtempSync(join(fixturesDir, "tmp-app-"));
  dirs.push(root);
  cpSync(join(fixturesDir, "app-basic"), join(root, "app-basic"), { recursive: true });
  cpSync(join(fixturesDir, "tsconfig.json"), join(root, "tsconfig.json"));
  // A single, realistic copy: catalog lives as a sibling of app-basic, exactly where
  // readCatalogs (resolving "../catalog/ui" relative to app.yaml) validates it.
  // resolveApp rewrites that specifier to be correct as seen from generated/ before
  // it is ever written into emitted code, so no second copy nested under app-basic
  // is needed here.
  cpSync(join(fixturesDir, "catalog"), join(root, "catalog"), { recursive: true });
  return join(root, "app-basic");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.json"),
});

describe("compileApp", () => {
  it("compiles the fixture app and writes five files", async () => {
    const appDir = fixtureCopy();
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.name).sort()).toEqual([
      "__contract.ts",
      "handlers.ts",
      "pages.tsx",
      "runtime.tsx",
      "types.ts",
    ]);
    expect(readFileSync(join(appDir, "generated", "pages.tsx"), "utf8")).toContain("<Table");
  });

  it("is byte-deterministic across runs", async () => {
    const appDir = fixtureCopy();
    const a = await compileApp(appDir, configFor(appDir));
    const b = await compileApp(appDir, configFor(appDir));
    expect(a.files.map((f) => f.text)).toEqual(b.files.map((f) => f.text));
  });

  it("writes nothing when write is false", async () => {
    const appDir = fixtureCopy();
    const result = await compileApp(appDir, configFor(appDir), { write: false });
    expect(result.written).toEqual([]);
    expect(result.files.length).toBe(5);
    expect(() => readFileSync(join(appDir, "generated", "pages.tsx"), "utf8")).toThrow();
  });

  it("stops after validation errors without emitting", async () => {
    const appDir = fixtureCopy();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(appDir, "app.yaml"), 'pages:\n  "/":\n    titel: x\n    sections: []\n');
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
  });

  it("stops after resolution errors without emitting", async () => {
    const appDir = fixtureCopy();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(appDir, "app.yaml"), 'pages:\n  "/":\n    sections:\n      - Tabel: {}\n');
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2001"]);
  });

  it("reports a missing app.yaml rather than throwing", async () => {
    const appDir = fixtureCopy();
    rmSync(join(appDir, "app.yaml"));
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("NOVA1006");
  });
});

// A `ts.Program` is by far the most expensive thing nova builds, and a host runs
// compileApp once per app on every dev-server rebuild. These pin the count so that
// re-adding a program — or quietly dropping the session on its way down to
// catalog/resolve/typecheck, which would make every stage build its own again — fails
// here rather than showing up as a minute-long build on a real repo.
describe("compileApp shares TypeScript work through a session", () => {
  it("builds exactly three programs for one app: catalog, exports, typecheck", async () => {
    const appDir = fixtureCopy();
    const session = createSession();
    const result = await compileApp(appDir, configFor(appDir), { session });
    expect(result.diagnostics).toEqual([]);
    expect(session.programs).toBe(3);
  });

  it("builds no extra programs for a second app on the same session", async () => {
    const first = fixtureCopy();
    const second = fixtureCopy();
    const session = createSession();
    await compileApp(first, configFor(first), { session });
    await compileApp(second, configFor(second), { session });
    expect(session.programs).toBe(6);
  });

  it("produces byte-identical output and identical diagnostics with and without one", async () => {
    const appDir = fixtureCopy();
    const other = fixtureCopy();
    const session = createSession();
    // Another app through the session first, so this one reads a warm cache.
    await compileApp(other, configFor(other), { session });
    const a = await compileApp(appDir, configFor(appDir), { session });
    const b = await compileApp(appDir, configFor(appDir));
    expect(a.diagnostics).toEqual(b.diagnostics);
    expect(a.files.map((f) => f.text)).toEqual(b.files.map((f) => f.text));
  });

  it("sees an edit made between two calls on the same session", async () => {
    const appDir = fixtureCopy();
    const session = createSession();
    const before = await compileApp(appDir, configFor(appDir), { session });
    expect(before.diagnostics).toEqual([]);
    // The cached parse of data.ts must not survive a change to it.
    const { readFileSync: read, writeFileSync } = await import("node:fs");
    const data = join(appDir, "data.ts");
    writeFileSync(data, read(data, "utf8").replace(/export async function trips/, "export async function tripz"));
    const after = await compileApp(appDir, configFor(appDir), { session });
    expect(after.ok).toBe(false);
    expect(after.diagnostics.map((d) => d.code)).toEqual(["NOVA2002"]);
  });
});
