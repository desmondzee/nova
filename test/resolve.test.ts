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

  it("collects components with the module to import them from", () => {
    const { resolved } = run();
    expect(resolved!.components).toEqual([
      { name: "EmptyState", module: "../catalog/ui" },
      { name: "ErrorNotice", module: "../catalog/ui" },
      { name: "Loading", module: "../catalog/ui" },
      { name: "StatCard", module: "../catalog/ui" },
      { name: "Table", module: "../catalog/ui" },
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
});
