import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  it("compiles the fixture app and writes six files", async () => {
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
      "views.tsx",
    ]);
    // Six, not five: the route map and the page components are two modules, because a
    // server component cannot read a map exported from a "use client" one.
    expect(readFileSync(join(appDir, "generated", "views.tsx"), "utf8")).toContain("<Table");
    expect(readFileSync(join(appDir, "generated", "pages.tsx"), "utf8")).toContain('"/": Page_0,');
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
    expect(result.files.length).toBe(6);
    expect(() => readFileSync(join(appDir, "generated", "pages.tsx"), "utf8")).toThrow();
  });

  /**
   * `outDir: "."` puts the output beside `data.ts`, which the README explicitly invites
   * ("so is a path that escapes the app folder … and so is an absolute one"), and all
   * six output names are ordinary names in a hand-written app folder. Nova used to write
   * over whatever was there and answer `ok: true`.
   */
  it("refuses to overwrite a file it did not write, and keeps its contents", async () => {
    const appDir = fixtureCopy();
    const mine = "export const MY_PRECIOUS = 1; // hand-written\n";
    writeFileSync(join(appDir, "types.ts"), mine);
    const result = await compileApp(appDir, { ...configFor(appDir), outDir: "." });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2016"]);
    expect(result.diagnostics[0]!.message).toContain("types.ts");
    expect(result.diagnostics[0]!.file).toBe(join(appDir, "types.ts"));
    // Untouched, and nothing else written either — the refusal is all-or-nothing, so a
    // build never leaves half a generated/ behind next to a file it would not replace.
    expect(readFileSync(join(appDir, "types.ts"), "utf8")).toBe(mine);
    expect(result.written).toEqual([]);
    expect(existsSync(join(appDir, "handlers.ts"))).toBe(false);
    // The emit itself succeeded, so the caller can still diff what nova would have written.
    expect(result.files.length).toBe(6);
  });

  it("names every occupied output, not just the first", async () => {
    const appDir = fixtureCopy();
    writeFileSync(join(appDir, "types.ts"), "export const a = 1;\n");
    writeFileSync(join(appDir, "handlers.ts"), "export const b = 1;\n");
    const result = await compileApp(appDir, { ...configFor(appDir), outDir: "." });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2016", "NOVA2016"]);
  });

  it("overwrites its own output without complaint", async () => {
    const appDir = fixtureCopy();
    const first = await compileApp(appDir, configFor(appDir));
    expect(first.ok).toBe(true);
    const second = await compileApp(appDir, configFor(appDir));
    expect(second.diagnostics).toEqual([]);
    expect(second.written.length).toBe(6);
  });

  it("refuses a directory sitting at an output name", async () => {
    const appDir = fixtureCopy();
    mkdirSync(join(appDir, "generated", "types.ts"), { recursive: true });
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2016"]);
  });

  /**
   * macOS and Windows fold case, so `ts.Program.getSourceFile` answers yes for `Data.ts`
   * asked as `data.ts` — and nova then emitted `from "../data"`, which does not resolve
   * on Linux. Clean local build, `ok: true`, zero diagnostics, CI failure inside
   * generated code the author never wrote.
   */
  it("reports an app module whose filename differs in case", async () => {
    const appDir = fixtureCopy();
    renameSync(join(appDir, "data.ts"), join(appDir, "Data.ts"));
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("NOVA2015");
    const reported = result.diagnostics.find((d) => d.code === "NOVA2015")!;
    expect(reported.message).toContain("Data.ts");
    expect(reported.file).toBe(join(appDir, "Data.ts"));
    // Refused rather than accommodated: nothing is emitted, so no `from "../data"` can
    // reach a case-sensitive filesystem.
    expect(result.written).toEqual([]);
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
