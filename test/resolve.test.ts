import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { loadSpecFile } from "../src/compile/load.js";
import { resolveApp } from "../src/compile/resolve.js";
import { validate } from "../src/schema/validate.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SPEC_FILE = here("./fixtures/app-basic/app.yaml");
const APP_DIR = dirname(SPEC_FILE);

const config: NovaConfig = {
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: here("./fixtures/tsconfig.json"),
};

function run(source = readFileSync(SPEC_FILE, "utf8")) {
  const { raw, positions } = loadSpecFile(SPEC_FILE, source);
  const { spec } = validate(raw, positions);
  const { catalog } = readCatalogs(config, SPEC_FILE);
  return resolveApp(spec!, { config, appDir: APP_DIR, specFile: SPEC_FILE, catalog, positions });
}

describe("resolveApp", () => {
  it("resolves the fixture app with no diagnostics", () => {
    const { resolved, diagnostics } = run();
    expect(diagnostics).toEqual([]);
    expect(resolved).not.toBeNull();
  });

  it("collects components with the module to import them from, rewritten as seen from outDir", () => {
    const { resolved } = run();
    // catalog.ts resolves "../catalog/ui" relative to app.yaml (APP_DIR). resolveApp
    // rewrites that to be correct from APP_DIR/generated instead, since that's where the
    // module specifier actually ends up (verbatim, in emitted code): one more ".." to
    // climb back out of "generated" than out of APP_DIR itself.
    //
    // EmptyState is deliberately absent: the fixture spec never renders it (no generated
    // page emits the empty state yet — see README limitations), and states.loading/error
    // are pulled in only because this fixture binds loaders. Forcing all three states
    // into the import list regardless of use is exactly what broke a host with
    // `noUnusedLocals` (see roundtrip.test.ts's "noUnusedLocals" case) — components here
    // must mirror what pages.tsx actually imports.
    expect(resolved!.components).toEqual([
      { name: "ErrorNotice", module: "../../catalog/ui" },
      { name: "Loading", module: "../../catalog/ui" },
      { name: "StatCard", module: "../../catalog/ui" },
      { name: "Table", module: "../../catalog/ui" },
    ]);
  });

  it("collects only the loaders the spec actually references", () => {
    const { resolved } = run();
    expect(resolved!.loaders).toEqual(["monthlyTotal", "trips"]);
    expect(resolved!.actions).toEqual([]);
  });

  it("reports an unknown component with a suggestion", () => {
    const { diagnostics } = run('pages:\n  "/":\n    sections:\n      - Tabel: {}\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("NOVA2001");
    expect(diagnostics[0]!.hint).toBe("did you mean 'Table'?");
  });

  it("reports an unknown data export", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: data#nope }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2002"]);
  });

  it("reports a param that the route does not declare", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: params.id }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2005"]);
  });

  it("accepts a param the route does declare", () => {
    const { diagnostics } = run(
      'pages:\n  "/trip/:id":\n    sections:\n      - StatCard: { label: a, value: params.id }\n',
    );
    expect(diagnostics).toEqual([]);
  });

  it("reports a filter the page does not declare", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: filters.month }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2006"]);
  });

  it("reports an unknown actions export", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: actions#nope }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2003"]);
  });

  it("reports an unknown compute export", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: compute#nope }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2004"]);
  });

  it("resolves a local component whose module and export both exist", () => {
    const { resolved, diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - "./collide#Table": {}\n',
    );
    expect(diagnostics).toEqual([]);
    // "./collide" (relative to app.yaml) becomes "../collide" as seen from generated/.
    expect(resolved!.components).toContainEqual({ name: "Table", module: "../collide" });
  });

  it("reports a local component whose module cannot be resolved", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - "./nonexistent#Widget": {}\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2007"]);
  });

  it("reports a local component export that does not exist in a module that does", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - "./collide#Nope": {}\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2008"]);
  });

  it("reports exactly one collision when a catalog and a local component share a name", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - Table: {}\n      - "./collide#Table": {}\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2009"]);
  });

  it("leaves a bare catalog specifier unchanged, with no relative rewriting applied", () => {
    // Every other fixture config uses a relative catalog path, so specifierFromOutDir's
    // bare-specifier passthrough (`if (!specifier.startsWith(".")) return specifier;`)
    // is otherwise never exercised — yet a real host's catalogs are published package
    // names, so this is the branch it actually uses. "@fixture/ui" is a made-up path
    // mapping in the fixture tsconfig (paths: { "@fixture/ui": ["./catalog/ui.tsx"] }),
    // pointing at the same catalog file the relative-specifier tests use.
    const bareConfig: NovaConfig = { ...config, components: ["@fixture/ui"] };
    const { raw, positions } = loadSpecFile(SPEC_FILE, readFileSync(SPEC_FILE, "utf8"));
    const { spec } = validate(raw, positions);
    const { catalog, diagnostics: catalogDiags } = readCatalogs(bareConfig, SPEC_FILE);
    expect(catalogDiags).toEqual([]);
    const { resolved, diagnostics } = resolveApp(spec!, {
      config: bareConfig,
      appDir: APP_DIR,
      specFile: SPEC_FILE,
      catalog,
      positions,
    });
    expect(diagnostics).toEqual([]);
    expect(resolved!.components).toContainEqual({ name: "Table", module: "@fixture/ui" });
    expect(resolved!.components).toContainEqual({ name: "StatCard", module: "@fixture/ui" });
    for (const c of resolved!.components) {
      expect(c.module).toBe("@fixture/ui");
    }
  });

  it("prefers .ts exports over .tsx exports for the same base name", () => {
    const specFile = here("./fixtures/app-tiebreak/app.yaml");
    const appDir = dirname(specFile);
    const source = readFileSync(specFile, "utf8");
    const { raw, positions } = loadSpecFile(specFile, source);
    const { spec } = validate(raw, positions);
    const { catalog } = readCatalogs(config, specFile);
    const { resolved, diagnostics } = resolveApp(spec!, {
      config,
      appDir,
      specFile,
      catalog,
      positions,
    });
    expect(diagnostics).toEqual([]);
    expect(resolved!.loaders).toEqual(["fromTs"]);
  });
});
