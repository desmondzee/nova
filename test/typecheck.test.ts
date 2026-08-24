import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Emitter } from "../src/compile/emit/emitter.js";
import type { EmittedFile } from "../src/compile/emit/types.js";
import type { PositionMap } from "../src/compile/load.js";
import { typecheckEmitted } from "../src/compile/typecheck.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TSCONFIG = here("./fixtures/tsconfig.json");

const positions: PositionMap = {
  at: (path) => ({ file: "app.yaml", line: path.length === 0 ? 1 : 42, col: 3 }),
};

function scratch(files: EmittedFile[]): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-"));
  for (const f of files) writeFileSync(join(dir, f.name), f.text);
  return dir;
}

function file(name: string, lines: string[], origins: Record<number, (string | number)[]>): EmittedFile {
  const e = new Emitter();
  lines.forEach((l, i) => e.line(l, origins[i + 1]));
  return { name, text: e.text(), map: e.map() };
}

describe("typecheckEmitted", () => {
  it("reports nothing for well-typed output", () => {
    const f = file("ok.ts", ["export const n: number = 1;"], {});
    const dir = scratch([f]);
    expect(typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions })).toEqual([]);
  });

  // Nothing imports test/fixtures/ambient.d.ts; it is in the program only because
  // every `.d.ts` the tsconfig's `include` matches is kept as a root. Drop that and a
  // host whose globals, JSX types or module augmentations live in a `.d.ts` starts
  // getting phantom errors in emitted output.
  it("sees a global from an ambient .d.ts under the tsconfig include", () => {
    const f = file("ambient-ok.ts", ["export const s: string = NOVA_AMBIENT_GLOBAL;"], {});
    const dir = scratch([f]);
    expect(typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions })).toEqual([]);
  });

  it("still reports a global that no ambient file declares", () => {
    const f = file("ambient-bad.ts", ["export const s: string = NOVA_NOT_DECLARED;"], {});
    const dir = scratch([f]);
    const out = typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out.map((d) => d.code)).toEqual(["NOVA3002"]);
    expect(out[0]!.message).toContain("NOVA_NOT_DECLARED");
  });

  it("remaps a type error to the spec position that produced the line", () => {
    const f = file("bad.ts", ["export const n: number = 1;", 'export const s: string = 2;'], {
      2: ["pages", "/", "sections", 0],
    });
    const dir = scratch([f]);
    const out = typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe("NOVA3001");
    expect(out[0]!.file).toBe("app.yaml");
    expect(out[0]!.line).toBe(42);
    expect(out[0]!.related?.[0]?.file).toContain("bad.ts");
  });

  it("keeps the generated location when a line has no spec origin", () => {
    const f = file("orphan.ts", ['export const s: string = 2;'], {});
    const dir = scratch([f]);
    const out = typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe("NOVA3002");
    expect(out[0]!.file).toContain("orphan.ts");
    expect(out[0]!.line).toBe(1);
  });

  it("reports every error rather than the first", () => {
    const f = file("many.ts", ['export const a: string = 1;', 'export const b: string = 2;'], {});
    const dir = scratch([f]);
    expect(typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions })).toHaveLength(2);
  });

  it("remaps a syntax error to the spec position that produced the line", () => {
    const f = file("syntax-bad.ts", ["export const n: number = 1;", "}"], {
      2: ["pages", "/", "sections", 0],
    });
    const dir = scratch([f]);
    const out = typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe("NOVA3001");
    expect(out[0]!.file).toBe("app.yaml");
    expect(out[0]!.line).toBe(42);
    expect(out[0]!.related?.[0]?.file).toContain("syntax-bad.ts");
  });

  it("keeps the generated location for a syntax error with no spec origin", () => {
    const f = file("syntax-orphan.ts", ["}"], {});
    const dir = scratch([f]);
    const out = typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe("NOVA3002");
    expect(out[0]!.file).toContain("syntax-orphan.ts");
    expect(out[0]!.line).toBe(1);
  });

  it("does not report diagnostics from files outside opts.files", () => {
    const main = file("main.ts", ['import { h } from "./helper.js";', "export const n: number = h;"], {});
    const dir = scratch([main]);
    writeFileSync(join(dir, "helper.ts"), 'export const h: number = "nope";\n');
    const out = typecheckEmitted({ files: [main], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out).toEqual([]);
  });
});
