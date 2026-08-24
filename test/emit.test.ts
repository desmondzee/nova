import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { emitContract, emitHandlers, emitPages, emitRuntime, emitTypes } from "../src/compile/emit/index.js";
import { loadSpecFile } from "../src/compile/load.js";
import { resolveApp } from "../src/compile/resolve.js";
import { validate } from "../src/schema/validate.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SPEC_FILE = here("./fixtures/app-basic/app.yaml");

const config: NovaConfig = {
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: here("./fixtures/tsconfig.json"),
};

function resolved() {
  const source = readFileSync(SPEC_FILE, "utf8");
  const { raw, positions } = loadSpecFile(SPEC_FILE, source);
  const { spec } = validate(raw, positions);
  const { catalog } = readCatalogs(config, SPEC_FILE);
  return resolveApp(spec!, {
    config,
    appDir: dirname(SPEC_FILE),
    specFile: SPEC_FILE,
    catalog,
    positions,
  }).resolved!;
}

describe("emitTypes", () => {
  it("derives loader types with TypeScript operators rather than printed text", () => {
    const { text } = emitTypes(resolved(), config);
    expect(text).toContain('import type * as data from "../data";');
    expect(text).toContain("export type Trips = Awaited<ReturnType<typeof data.trips>>;");
    expect(text).toContain("export type MonthlyTotal = Awaited<ReturnType<typeof data.monthlyTotal>>;");
  });

  it("appends the configured import extension", () => {
    const { text } = emitTypes(resolved(), { ...config, importExtension: ".js" });
    expect(text).toContain('import type * as data from "../data.js";');
  });
});

describe("emitRuntime", () => {
  it("emits the hooks generated pages depend on and imports nothing from nova", () => {
    const { text } = emitRuntime(resolved(), config);
    for (const hook of ["useLoader", "useFilters", "useAction"]) {
      expect(text).toContain(`export function ${hook}`);
    }
    expect(text).not.toContain("@light/nova");
  });
});

describe("emitPages", () => {
  it("imports components from their catalog module and nothing from nova", () => {
    const { text } = emitPages(resolved(), config);
    expect(text).toContain('import { EmptyState, ErrorNotice, Loading, StatCard, Table } from "../catalog/ui";');
    expect(text).not.toContain("@light/nova");
    expect(text).not.toContain("@platform/");
  });

  it("exports a structurally typed pages map with no host type import", () => {
    const { text } = emitPages(resolved(), config);
    expect(text).toContain("export const pages: Record<");
    expect(text).toContain('"/": Page_0,');
  });

  it("renders literal props as literals and bindings as expressions", () => {
    const { text } = emitPages(resolved(), config);
    expect(text).toContain('label={"This month"}');
    expect(text).toContain("rows={trips.value}");
  });

  it("maps a generated line back to the section that produced it", () => {
    const { text, map } = emitPages(resolved(), config);
    const lineNo = text.split("\n").findIndex((l) => l.includes("<Table")) + 1;
    expect(map.get(lineNo)).toEqual(["pages", "/", "sections", 1]);
  });
});

describe("emitHandlers", () => {
  it("emits one GET per referenced loader", () => {
    const { text } = emitHandlers(resolved(), config);
    expect(text).toContain('"GET /_data/trips"');
    expect(text).toContain('"GET /_data/monthlyTotal"');
  });

  it("uses Web standard types only", () => {
    const { text } = emitHandlers(resolved(), config);
    expect(text).toContain("(req: Request)");
    expect(text).toContain("Promise<Response>");
    expect(text).not.toContain("@platform/");
  });
});

describe("emitContract", () => {
  it("binds each referenced export to its derived type", () => {
    const { text } = emitContract(resolved(), config);
    expect(text).toContain("const _trips: (input: TripsInput) => Promise<Trips> = data.trips;");
  });
});

describe("determinism", () => {
  it("produces identical bytes on repeated runs", () => {
    const a = resolved();
    const b = resolved();
    for (const emit of [emitTypes, emitRuntime, emitPages, emitHandlers, emitContract]) {
      expect(emit(a, config).text).toBe(emit(b, config).text);
    }
  });
});
