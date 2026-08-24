import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { emitContract, emitHandlers, emitPages, emitRuntime, emitTypes } from "../src/compile/emit/index.js";
import { loadSpecFile, type PositionMap } from "../src/compile/load.js";
import { resolveApp } from "../src/compile/resolve.js";
import { typecheckEmitted } from "../src/compile/typecheck.js";
import { validate } from "../src/schema/validate.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SPEC_FILE = here("./fixtures/app-basic/app.yaml");
const FIXTURES_DIR = here("./fixtures/");

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

function specPositions(): PositionMap {
  const source = readFileSync(SPEC_FILE, "utf8");
  return loadSpecFile(SPEC_FILE, source).positions;
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
    // "../catalog/ui" (relative to app.yaml) is rewritten by resolveApp to "../../catalog/ui"
    // as seen from APP_DIR/generated, where this import actually ends up.
    expect(text).toContain(
      'import { EmptyState, ErrorNotice, Loading, StatCard, Table } from "../../catalog/ui";',
    );
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

describe("typechecks emitted output", () => {
  it("produces no semantic diagnostics for the fixture app", () => {
    const app = resolved();
    const files = [emitTypes, emitRuntime, emitPages, emitHandlers, emitContract].map((emit) => emit(app, config));

    // Written alongside the fixture app (not a bare OS tmpdir) so that
    // node_modules resolution walking up from the generated files still
    // finds the project's real "react"/"typescript" packages. "tmp" is created as a
    // direct child of FIXTURES_DIR — the same nesting depth as app-basic — so it does
    // not need its own catalog copy: resolveApp already rewrote the catalog import to
    // "../../catalog/ui" (as seen from an app's generated/ directory), and that same
    // two-levels-up path from tmp/generated lands on the one real fixtures/catalog.
    const tmp = mkdtempSync(join(FIXTURES_DIR, ".tmp-emit-"));
    try {
      const generatedDir = join(tmp, "generated");
      mkdirSync(generatedDir, { recursive: true });

      copyFileSync(here("./fixtures/app-basic/data.ts"), join(tmp, "data.ts"));
      copyFileSync(here("./fixtures/app-basic/actions.ts"), join(tmp, "actions.ts"));

      for (const file of files) {
        writeFileSync(join(generatedDir, file.name), file.text);
      }

      const baseTsconfig = JSON.parse(readFileSync(here("./fixtures/tsconfig.json"), "utf8")) as {
        compilerOptions: unknown;
      };
      const tmpTsconfigPath = join(tmp, "tsconfig.json");
      writeFileSync(
        tmpTsconfigPath,
        JSON.stringify({ compilerOptions: baseTsconfig.compilerOptions, include: [] }),
      );

      const diagnostics = typecheckEmitted({
        files,
        outDir: generatedDir,
        tsconfigPath: tmpTsconfigPath,
        positions: specPositions(),
      });
      expect(diagnostics, JSON.stringify(diagnostics, null, 2)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

  it("is insensitive to the order components were resolved in", () => {
    const app = resolved();
    const reordered = { ...app, components: [...app.components].reverse() };
    expect(emitPages(reordered, config).text).toBe(emitPages(app, config).text);
  });
});
