import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const APP = here("./fixtures/app-basic/app.yaml");

const config = (components: string[]): NovaConfig => ({
  components,
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: here("./fixtures/tsconfig.json"),
});

describe("readCatalogs", () => {
  it("collects capitalised callable exports and ignores the rest", () => {
    const { catalog, diagnostics } = readCatalogs(config(["../catalog/ui"]), APP);
    expect(diagnostics).toEqual([]);
    expect(catalog.names()).toEqual(["EmptyState", "ErrorNotice", "Loading", "StatCard", "Table"]);
  });

  it("records the module specifier to emit, not the resolved path", () => {
    const { catalog } = readCatalogs(config(["../catalog/ui"]), APP);
    expect(catalog.get("Table")!.module).toBe("../catalog/ui");
    expect(catalog.get("Table")!.file).toBe(here("./fixtures/catalog/ui.tsx"));
  });

  it("returns undefined for an unknown name", () => {
    const { catalog } = readCatalogs(config(["../catalog/ui"]), APP);
    expect(catalog.get("Tabel")).toBeUndefined();
  });

  it("reports an unresolvable catalog module", () => {
    const { diagnostics } = readCatalogs(config(["@nope/ui"]), APP);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("NOVA2000");
  });

  it("reports a name exported by two catalogs", () => {
    const { diagnostics } = readCatalogs(config(["../catalog/ui", "../catalog/ui"]), APP);
    expect(diagnostics.map((d) => d.code)).toContain("NOVA2010");
  });
});
