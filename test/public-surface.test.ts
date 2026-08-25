// Everything here imports ONLY from the two published entry points — `src/schema/index.ts`
// and `src/compile/index.ts`, which are exactly what package.json's "./schema" and
// "./compile" subpaths point at once built. No deep `src/` path appears in this file on
// purpose: an external consumer cannot reach one, so neither may this test. If a symbol
// or type is needed here and is not re-exported from a barrel, the test fails to compile,
// which is the point.
import { describe, expect, it } from "vitest";
import {
  compileApp,
  loadSpecFile,
  parseSpec,
  type AppSpec,
  type Diagnostic,
  type EmittedFile,
  type LineMap,
  type NovaConfig,
  type Position,
  type PositionMap,
  type Related,
  type Severity,
  type SpecPath,
} from "../src/compile/index.js";
import {
  atFile,
  validate,
  type AppSpec as SchemaAppSpec,
  type Diagnostic as SchemaDiagnostic,
} from "../src/schema/index.js";

const SPEC = ['pages:', '  "/":', "    title: Trips", "    sections:", "      - Table", ""].join(
  "\n",
);

describe("@desmondzee/nova/compile — parseSpec", () => {
  it("validates a spec file in one call, with no PositionMap supplied by the caller", () => {
    const { spec, diagnostics } = parseSpec("app.yaml", SPEC);
    expect(diagnostics).toEqual([]);
    expect(spec!.pages).toHaveLength(1);
    expect(spec!.pages[0]!.route).toBe("/");
  });

  it("reports a schema error at its real line and column", () => {
    const { spec, diagnostics } = parseSpec(
      "app.yaml",
      'pages:\n  "/":\n    titel: Trips\n    sections: []\n',
    );
    expect(spec).toBeNull();
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
    // The whole point of bundling load+validate: a real line, not a 1:1 fallback.
    expect(diagnostics[0]!.line).toBe(3);
    expect(diagnostics[0]!.file).toBe("app.yaml");
  });

  it("reports malformed YAML rather than throwing", () => {
    const { spec, diagnostics } = parseSpec("app.yaml", "pages:\n  - a\n  b: c\n");
    expect(spec).toBeNull();
    expect(diagnostics[0]!.code).toBe("NOVA1000");
  });

  it("exposes loadSpecFile so a consumer can drive validate itself", () => {
    const { raw, positions } = loadSpecFile("app.yaml", SPEC);
    const { spec, diagnostics } = validate(raw, positions);
    expect(diagnostics).toEqual([]);
    expect(spec!.pages[0]!.title).toBe("Trips");
  });
});

describe("@desmondzee/nova/schema — validate is callable without the compile entry point", () => {
  it("validates an already-parsed document with the dependency-free position fallback", () => {
    // The scenario ./schema exists for: a consumer that must not load TypeScript (or
    // even yaml) and already holds a parsed document. `atFile` is the position sidecar
    // that used to have no shippable implementation at all.
    const raw = { pages: { "/": { title: "Trips", sections: ["Table"] } } };
    const { spec, diagnostics } = validate(raw, atFile("app.yaml"));
    expect(diagnostics).toEqual([]);
    expect(spec!.pages[0]!.title).toBe("Trips");
  });

  it("still reports every diagnostic, pinned to the file it was given", () => {
    const raw = { pages: { "/": { titel: "Trips", sections: [] } } };
    const { diagnostics } = validate(raw, atFile("app.yaml"));
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
    expect(diagnostics[0]!.file).toBe("app.yaml");
    expect(diagnostics[0]!.line).toBe(1);
  });
});

describe("public types are nameable from the entry point that reaches them", () => {
  it("names every type reachable through a ./compile signature", () => {
    // Each of these compiles only because the type is re-exported. `LineMap` and
    // `SpecPath` in particular were previously nameable from neither subpath, so
    // `EmittedFile.map` could not be written down by a consumer at all.
    const severity: Severity = "error";
    const position: Position = { file: "app.yaml", line: 1, col: 1 };
    const related: Related = { ...position, message: "in generated output" };
    const path: SpecPath = ["pages", "/", "sections", 0];
    const map: LineMap = new Map([[1, path]]);
    const file: EmittedFile = { name: "pages.tsx", text: "", map };
    const diagnostic: Diagnostic = {
      code: "NOVA3001",
      severity,
      message: "boom",
      file: "app.yaml",
      line: 1,
      col: 1,
      related: [related],
    };
    const config: NovaConfig = {
      components: ["@acme/ui"],
      states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
      outDir: "generated",
      tsconfigPath: "tsconfig.json",
    };
    const positions: PositionMap = atFile("app.yaml");
    const spec: AppSpec = { pages: [] };

    // A consumer's own helper, written against the public types only.
    const originOf = (f: EmittedFile, line: number): SpecPath | undefined => f.map.get(line);
    expect(originOf(file, 1)).toEqual(["pages", "/", "sections", 0]);
    expect(diagnostic.related![0]!.message).toBe("in generated output");
    expect(config.outDir).toBe("generated");
    expect(positions.at([])).toEqual(position);
    expect(spec.pages).toEqual([]);
    expect(typeof compileApp).toBe("function");
  });

  it("names the same shared types through ./schema", () => {
    const empty: SchemaAppSpec = { pages: [] };
    const d: SchemaDiagnostic | undefined = validate({ pagez: {} }, atFile("a.yaml"))
      .diagnostics[0];
    expect(empty.pages).toEqual([]);
    expect(d!.code).toBe("NOVA1001");
    expect(d!.hint).toBe("did you mean 'pages'?");
  });
});
