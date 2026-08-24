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
});
