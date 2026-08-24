import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram, moduleExports, resolveModule } from "../src/compile/program.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TSCONFIG = here("./fixtures/tsconfig.json");
const CATALOG = here("./fixtures/catalog/ui.tsx");
const DATA = here("./fixtures/app-basic/data.ts");

describe("createProgram", () => {
  it("builds a program from a tsconfig and roots", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] });
    expect(p).not.toBeNull();
    expect(p!.program.getSourceFile(CATALOG)).toBeDefined();
  });

  it("returns null when the tsconfig does not exist", () => {
    expect(createProgram({ tsconfigPath: here("./nope.json"), roots: [] })).toBeNull();
  });
});

describe("moduleExports", () => {
  it("lists every export with callability and position", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    const names = moduleExports(p.program, CATALOG).map((e) => e.name);
    expect(names).toEqual(["EmptyState", "ErrorNotice", "Loading", "MONTHS", "StatCard", "Table", "formatKm"]);
  });

  it("marks functions callable and constants not", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    const byName = new Map(moduleExports(p.program, CATALOG).map((e) => [e.name, e]));
    expect(byName.get("Table")!.callable).toBe(true);
    expect(byName.get("formatKm")!.callable).toBe(true);
    expect(byName.get("MONTHS")!.callable).toBe(false);
  });

  it("reports the declaration position", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    const table = moduleExports(p.program, CATALOG).find((e) => e.name === "Table")!;
    expect(table.file).toBe(CATALOG);
    expect(table.line).toBe(3);
  });

  it("reads a plain .ts module", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [DATA] })!;
    expect(moduleExports(p.program, DATA).map((e) => e.name)).toEqual([
      "Trip",
      "monthlyTotal",
      "trips",
    ]);
  });

  it("returns an empty list for a file not in the program", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    expect(moduleExports(p.program, here("./fixtures/missing.ts"))).toEqual([]);
  });
});

describe("resolveModule", () => {
  it("resolves a relative specifier to a file path", () => {
    expect(resolveModule("./data", here("./fixtures/app-basic/app.yaml"), TSCONFIG)).toBe(DATA);
  });

  it("returns null for an unresolvable specifier", () => {
    expect(resolveModule("@nope/nothing", CATALOG, TSCONFIG)).toBeNull();
  });
});
