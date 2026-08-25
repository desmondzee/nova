import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createProgram,
  createSession,
  moduleExports,
  resolveModule,
} from "../src/compile/program.js";

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

  // The tsconfig here matches every .ts/.tsx under test/fixtures. Unioning that whole
  // set into the roots — which is what this used to do — is what made a host build
  // re-parse its entire repository once per call, three or four times per app.
  it("pulls in the roots and what they import, not the whole tsconfig include set", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [DATA] })!;
    expect(p.program.getSourceFile(DATA)).toBeDefined();
    expect(p.program.getSourceFile(CATALOG)).toBeUndefined();
  });

  it("reuses a parsed source file across programs built from one session", () => {
    const session = createSession();
    const a = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG], session })!;
    const b = createProgram({ tsconfigPath: TSCONFIG, roots: [DATA], session })!;
    const shared = a.program.getSourceFiles().find((f) => f.fileName.endsWith("lib.es2022.d.ts"));
    expect(shared).toBeDefined();
    // Same object, not an equal one: the second program did not re-read or re-parse it.
    expect(b.program.getSourceFile(shared!.fileName)).toBe(shared);
    expect(session.programs).toBe(2);
  });

  it("counts every program it builds, so a caller can pin the number", () => {
    const session = createSession();
    createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG], session });
    createProgram({ tsconfigPath: here("./nope.json"), roots: [], session });
    expect(session.programs).toBe(1);
  });
});

describe("moduleExports", () => {
  it("lists every export with callability and position", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    const names = moduleExports(p.program, CATALOG).map((e) => e.name);
    expect(names).toEqual([
      "EmptyState",
      "ErrorNotice",
      "Loading",
      "MONTHS",
      "PageShell",
      "StatCard",
      "Table",
      "formatKm",
    ]);
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
