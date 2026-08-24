import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../src/compile/config.js";
import { compileApp } from "../src/compile/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturesDir = here("./fixtures/");

const dirs: string[] = [];

// Scratch trees are created inside the repo (under test/fixtures/), not the OS tmpdir.
// compileApp typechecks its emitted output, and pages.tsx imports "react" — Node
// resolves that by walking up from the file's location, and it would never reach this
// repo's node_modules starting from /tmp. Each fixture subtree is copied individually
// (rather than one recursive copy of "fixtures" into itself, which Node refuses) —
// same pattern as test/compile.test.ts and test/emit.test.ts.
function app(name: string): string {
  const root = mkdtempSync(join(fixturesDir, "tmp-app-"));
  dirs.push(root);
  cpSync(join(fixturesDir, name), join(root, name), { recursive: true });
  cpSync(join(fixturesDir, "tsconfig.json"), join(root, "tsconfig.json"));
  cpSync(join(fixturesDir, "tsconfig.strict.json"), join(root, "tsconfig.strict.json"));
  // A single, realistic copy: catalog lives as a sibling of the app directory, exactly
  // where readCatalogs (resolving "../catalog/ui" relative to app.yaml) validates it.
  // resolveApp rewrites that specifier to be correct as seen from generated/ before it
  // is ever written into emitted code, so no second copy nested under the app is needed.
  cpSync(join(fixturesDir, "catalog"), join(root, "catalog"), { recursive: true });
  return join(root, name);
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

describe("round trip", () => {
  it("emits output that typechecks clean for a correct spec", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("emits a page per route", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    const pages = result.files.find((f) => f.name === "pages.tsx")!.text;
    expect(pages).toContain('"/": Page_0,');
    expect(pages).toContain('"/trip/:id": Page_1,');
  });

  it("reports a prop/loader type mismatch at the YAML line, not the generated line", async () => {
    const appDir = app("app-broken");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const mismatch = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(mismatch).toBeDefined();
    expect(mismatch!.file).toBe(join(appDir, "app.yaml"));
    // The emitter maps whole JSX elements, so the origin is the `- Table:` section
    // node on line 6 — not the `rows:` line that supplied the offending prop.
    expect(mismatch!.line).toBe(6);
    expect(mismatch!.related?.[0]?.file).toContain("pages.tsx");
  });

  it("never leaves a diagnostic pointing only at generated code", async () => {
    const appDir = app("app-broken");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });

  it("compiles clean on a host tsconfig with noUnusedLocals and noUnusedParameters", async () => {
    // A host that turns these on is well within its rights, and every generated app
    // must compile there: an unconditionally-imported hook or state component that a
    // particular spec never uses would otherwise fail as "declared but its value is
    // never read", reported as NOVA3002 ("likely a nova bug") against the author's
    // perfectly reasonable spec.
    const appDir = app("app-basic");
    const config: NovaConfig = {
      ...configFor(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    };
    const result = await compileApp(appDir, config);
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("resolves app-root imports correctly under a nested outDir", async () => {
    // specifierFromOutDir (resolve.ts) already recomputes catalog/local-component
    // specifiers relative to outDir. The hand-written "../data"/"../actions"/"../compute"
    // imports in types.ts, handlers.ts, contract.ts (and the "../compute" import in
    // pages.ts) must track outDir's actual depth the same way, or they stay wrong for
    // any outDir nested more than one level below the app root.
    const appDir = app("app-basic");
    const config: NovaConfig = { ...configFor(appDir), outDir: "src/generated" };
    const result = await compileApp(appDir, config);
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const types = result.files.find((f) => f.name === "types.ts")!.text;
    expect(types).toContain('from "../../data"');
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).toContain('from "../../data"');
    const contract = result.files.find((f) => f.name === "__contract.ts")!.text;
    expect(contract).toContain('from "../../data"');
  });

  it("calls a zero-parameter loader with no argument", async () => {
    // Parameters<typeof data.status>[0] is `undefined` for a zero-parameter loader.
    // handlers.ts must not call it with an argument anyway — a loader with no inputs
    // is a normal pattern, not a spec error.
    const appDir = app("app-zeroparam");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).toContain("await data.status()");
    expect(handlers).not.toContain("data.status(input");
  });

  it("reports a contract-only diagnostic at the spec binding, not app.yaml:1:1", async () => {
    // __contract.ts's `(input: TripsInput) => Promise<Trips> = data.trips` catches a
    // non-async loader (Trips and TripsInput are both derived from data.trips itself,
    // so nothing else about that binding can fail). Before the fix, contract.ts mapped
    // every loader/action line to ["loaders", name] / ["actions", name] — paths that
    // don't exist in the YAML document — so positions.at() fell back to the document
    // root and every contract diagnostic landed at 1:1 regardless of the spec's shape.
    const appDir = app("app-sync-loader");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const mismatch = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(mismatch, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(mismatch!.file).toBe(join(appDir, "app.yaml"));
    expect(mismatch!.line).not.toBe(1);
    expect(mismatch!.col).not.toBe(1);
    // The `rows: data#trips` binding is the only place "trips" is referenced.
    expect(mismatch!.line).toBe(4);
  });
});
