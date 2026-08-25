import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { emitPages, emitRuntime, emitViews } from "../src/compile/emit/index.js";
import { compileApp } from "../src/compile/index.js";
import { loadSpecFile } from "../src/compile/load.js";
import { resolveApp } from "../src/compile/resolve.js";
import { typecheckEmitted } from "../src/compile/typecheck.js";
import { validate } from "../src/schema/validate.js";

// Eight defects found by building two foreign consumers — a Vite/React SPA on node:http
// and an Express/esbuild reporting app — against nothing but the README. Every test here
// fails against the code that shipped before it.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturesDir = here("./fixtures/");

const dirs: string[] = [];

function app(name: string): string {
  const root = mkdtempSync(join(fixturesDir, "tmp-gen-"));
  dirs.push(root);
  cpSync(join(fixturesDir, name), join(root, name), { recursive: true });
  cpSync(join(fixturesDir, "tsconfig.json"), join(root, "tsconfig.json"));
  cpSync(join(fixturesDir, "tsconfig.strict.json"), join(root, "tsconfig.strict.json"));
  cpSync(join(fixturesDir, "catalog"), join(root, "catalog"), { recursive: true });
  return join(root, name);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete (globalThis as { window?: unknown }).window;
});

/** Rewrite one fragment of a scratch app's spec, asserting it was there to rewrite. */
function edit(appDir: string, from: string, to: string): void {
  const specFile = join(appDir, "app.yaml");
  const source = readFileSync(specFile, "utf8");
  expect(source).toContain(from);
  writeFileSync(specFile, source.replace(from, to));
}

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui", "../catalog/forms"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.json"),
});

const fileOf = (files: { name: string; text: string }[], name: string) =>
  files.find((f) => f.name === name)!.text;

const show = (r: { diagnostics: unknown }) => JSON.stringify(r.diagnostics, null, 2);

/** Resolve a fixture in place — enough to emit one file and read it back. */
function resolvedFixture(name: string, cfg: NovaConfig) {
  const specFile = here(`./fixtures/${name}/app.yaml`);
  const source = readFileSync(specFile, "utf8");
  const { raw, positions } = loadSpecFile(specFile, source);
  const { spec } = validate(raw, positions);
  const { catalog } = readCatalogs(cfg, specFile);
  return resolveApp(spec!, {
    config: cfg,
    appDir: dirname(specFile),
    specFile,
    catalog,
    positions,
  }).resolved!;
}

const inPlace = configFor(join(fixturesDir, "app"));

function evaluateModule(source: string, load: (specifier: string) => unknown): unknown {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("exports", "require", js)(exports, load);
  return exports;
}

describe("N1 — a relative appDir must not silently disable the typecheck", () => {
  // The critical one. `typecheckEmitted` keyed its file map on `join(outDir, name)`;
  // TypeScript always reports `d.file.fileName` absolute, so with a relative appDir the
  // map matched nothing and every NOVA3001/NOVA3002 was dropped — `ok: true` on output
  // that does not compile. The README's own example passes a relative path.
  it("reports a known-bad spec compiled through a relative appDir", async () => {
    const appDir = app("app-missing-input");
    const relDir = relative(process.cwd(), appDir);
    expect(isAbsolute(relDir)).toBe(false);

    const result = await compileApp(relDir, configFor(appDir));
    expect(result.ok, show(result)).toBe(false);
    const missing = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(missing, show(result)).toBeDefined();
    expect(missing!.message).toContain("month");
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });

  it("answers a relative and an absolute appDir identically", async () => {
    const absDir = app("app-missing-input");
    const relDir = relative(process.cwd(), absDir);
    const fromRelative = await compileApp(relDir, configFor(absDir));
    const fromAbsolute = await compileApp(absDir, configFor(absDir));
    expect(fromRelative.ok).toBe(fromAbsolute.ok);
    expect(fromRelative.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual(
      fromAbsolute.diagnostics.map((d) => `${d.code} ${d.message}`),
    );
  });

  it("keys the emitted-file map absolutely even when handed a relative outDir", async () => {
    // The stage in isolation: no code path may compare a possibly-relative path against
    // a TypeScript file name, so typecheckEmitted resolves what it is given rather than
    // trusting its caller to.
    const appDir = app("app-missing-input");
    const absolute = await compileApp(appDir, configFor(appDir));
    const relOutDir = relative(process.cwd(), join(appDir, "generated"));
    expect(isAbsolute(relOutDir)).toBe(false);

    const specFile = join(appDir, "app.yaml");
    const { positions } = loadSpecFile(specFile, readFileSync(specFile, "utf8"));
    const diagnostics = typecheckEmitted({
      files: absolute.files,
      outDir: relOutDir,
      tsconfigPath: configFor(appDir).tsconfigPath,
      positions,
    });
    expect(diagnostics.map((d) => d.code)).toContain("NOVA3001");
  });

  it("builds no path in the typecheck stage that could be relative", () => {
    // The invariant behind the two tests above, stated where it can be reintroduced.
    // `join` preserves a relative first argument; `resolve` does not, and only `resolve`
    // may be used to build a key compared against a `ts.SourceFile.fileName`.
    const source = readFileSync(here("../src/compile/typecheck.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\bjoin\(/);
    expect(code).toMatch(/\bresolve\(opts\.outDir,/);
  });
});

describe("N2 — a loader is called with the input it declares, and no more", () => {
  it("passes a parameterless loader no query at all", async () => {
    const appDir = app("app-narrow-input");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, show(result)).toEqual([]);
    const views = fileOf(result.files, "views.tsx");
    // Was: `useLoader<Regions>("/_data/regions", { "month": …, "region": … })` — a
    // constant option list re-requested on every filter change.
    expect(views).toContain('const regions = useLoader<Regions>("/_data/regions", {});');
  });

  it("passes a one-key loader only the key it declares", async () => {
    const appDir = app("app-narrow-input");
    const result = await compileApp(appDir, configFor(appDir));
    const views = fileOf(result.files, "views.tsx");
    expect(views).toContain(
      'const monthlyTotal = useLoader<MonthlyTotal, MonthlyTotalInput>("/_data/monthlyTotal", { "month": filters["month"] });',
    );
    expect(views).not.toContain('"region": filters["region"]');
  });

  it("still reports a loader input that neither params nor filters supply", async () => {
    const appDir = app("app-missing-input");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const missing = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(missing, show(result)).toBeDefined();
    expect(missing!.message).toContain("month");
  });
});

describe("N4 — sort state reaches a loader that declares it", () => {
  it("supplies sort and dir to a loader whose input names them", async () => {
    const appDir = app("app-sort-loader");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, show(result)).toEqual([]);
    const views = fileOf(result.files, "views.tsx");
    expect(views).toContain(
      'const deals = useLoader<Deals, DealsInput>("/_data/deals", { "dir": (sortState.value?.direction ?? "asc"), "page": filters["page"], "sort": (sortState.value?.column ?? "") });',
    );
    // Hoisted before the loaders that read it — a const referenced above its
    // declaration is a ReferenceError, not a lint nit.
    expect(views.indexOf("const sortState = useSort();")).toBeLessThan(
      views.indexOf("const deals = useLoader"),
    );
  });

  it("leaves a loader that does not declare sort exactly as it was", async () => {
    const appDir = app("app-sort");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, show(result)).toEqual([]);
    const views = fileOf(result.files, "views.tsx");
    expect(views).toContain('const trips = useLoader<Trips>("/_data/trips", {});');
    expect(views).not.toContain("sortState.value?.column");
  });
});

describe("N3 — a filter or sort write keeps the location hash", () => {
  const react = () => ({
    useState: (init: unknown) => [
      typeof init === "function" ? (init as () => unknown)() : init,
      () => {},
    ],
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useRef: (value: unknown) => ({ current: value }),
  });

  const runtimeOf = (fixture: string) =>
    evaluateModule(emitRuntime(resolvedFixture(fixture, inPlace), inPlace).text, (m) => {
      if (m === "react") return react();
      throw new Error(`unexpected import ${m}`);
    }) as {
      useFilters?: (d: Record<string, string>) => Record<string, string> & {
        set(name: string, value: string): void;
      };
      useSort?: () => { value: unknown; set(column: string): void };
    };

  /** A hash-routed SPA's window: the route lives in the fragment. */
  function fakeWindow(search: string, hash: string): { written: string[] } {
    const written: string[] = [];
    (globalThis as { window?: unknown }).window = {
      location: { pathname: "/", search, hash },
      history: {
        replaceState: (_s: unknown, _t: unknown, url: string) => written.push(url),
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    return { written };
  }

  it("preserves the hash when a filter is set", () => {
    const { written } = fakeWindow("?month=2026-08", "#/vehicle/DP-771");
    const { useFilters } = runtimeOf("app-basic");
    useFilters!({ month: "2026-08" }).set("month", "2026-09");
    expect(written).toEqual(["/?month=2026-09#/vehicle/DP-771"]);
  });

  it("preserves the hash when a column is sorted", () => {
    const { written } = fakeWindow("?month=2026-08", "#/vehicle/DP-771");
    const { useSort } = runtimeOf("app-sort");
    useSort!().set("date");
    expect(written).toEqual(["/?month=2026-08&sort=date&dir=asc#/vehicle/DP-771"]);
  });

  it("writes no stray '#' when there is no hash", () => {
    const { written } = fakeWindow("?month=2026-08", "");
    const { useFilters } = runtimeOf("app-basic");
    useFilters!({ month: "2026-08" }).set("month", "2026-09");
    expect(written).toEqual(["/?month=2026-09"]);
  });
});

describe("N5 — a sortable column is checked against the row type, not a prop name", () => {
  it("accepts columns that are keys of the bound row type", async () => {
    const appDir = app("app-sortable-rows");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, show(result)).toEqual([]);
  });

  it("reports a sortable column the row type does not have, on a catalog spelling its column prop 'cols'", async () => {
    const appDir = app("app-sortable-rows");
    edit(appDir, "sortable: [date, km]", "sortable: [date, distance]");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok, show(result)).toBe(false);
    const bad = result.diagnostics.find((d) => d.message.includes("distance"));
    expect(bad, show(result)).toBeDefined();
    expect(bad!.code).toBe("NOVA3001");
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
    expect(bad!.line).toBe(7);
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });

  it("claims nothing about a section whose rows are not an object list", async () => {
    // `app-sort`'s loader returns Array<Record<string, unknown>> — every string is a key
    // of it, so the check passes vacuously rather than inventing a complaint.
    const appDir = app("app-sort");
    edit(appDir, "sortable: [date, km]", "sortable: [date, km, anything]");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics.filter((d) => d.code.startsWith("NOVA3")), show(result)).toEqual([]);
  });
});

describe("N5b — a column list is checked against the row type too", () => {
  // `sortable:` was checked against the row type and `columns:` was not, so
  // `columns: [dayz]` compiled clean and rendered a column of en dashes. `numeric:` —
  // the subset of those columns a table right-aligns — was not checked either, and a
  // typo in it silently did nothing at all.
  it("accepts a column list whose names are keys of the bound row type", async () => {
    const appDir = app("app-detail");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, show(result)).toEqual([]);
  });

  it("reports a columns entry the row type does not have, at the columns line", async () => {
    const appDir = app("app-detail");
    edit(appDir, "columns: [day, hours]", "columns: [dayz, hours]");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok, show(result)).toBe(false);
    const bad = result.diagnostics.find((d) => d.message.includes("dayz"));
    expect(bad, show(result)).toBeDefined();
    expect(bad!.code).toBe("NOVA3001");
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
    expect(bad!.line).toBe(10);
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });

  it("reports a numeric entry the row type does not have, at the numeric line", async () => {
    const appDir = app("app-detail");
    edit(appDir, "numeric: [hours]", "numeric: [hourz]");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok, show(result)).toBe(false);
    const bad = result.diagnostics.find((d) => d.message.includes("hourz"));
    expect(bad, show(result)).toBeDefined();
    expect(bad!.code).toBe("NOVA3001");
    expect(bad!.line).toBe(11);
  });

  it("claims nothing about a column list on a section whose rows are not an object list", async () => {
    const appDir = app("app-sections");
    edit(appDir, "columns: [date, km]", "columns: [date, km, anything]");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics.filter((d) => d.code.startsWith("NOVA3")), show(result)).toEqual([]);
  });
});

describe("N6 — a filter named sort or dir collides with the page's sort state", () => {
  it("reports NOVA1014 for a filter named sort beside a sortable section", async () => {
    const appDir = app("app-sort");
    edit(
      appDir,
      "  \"/\":\n    sections:",
      "  \"/\":\n    filters:\n      sort: { default: date }\n    sections:",
    );
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok, show(result)).toBe(false);
    const clash = result.diagnostics.find((d) => d.code === "NOVA1014");
    expect(clash, show(result)).toBeDefined();
    expect(clash!.message).toContain("sort");
  });

  it("leaves a filter named sort alone on a page with no sortable section", async () => {
    const appDir = app("app-filters-only");
    const before = await compileApp(appDir, configFor(appDir));
    expect(before.diagnostics.filter((d) => d.code === "NOVA1014")).toEqual([]);
  });
});

describe("N7 — 'fields:' is only form vocabulary where there is a form", () => {
  it("forwards a fields prop on a section with no submit", async () => {
    const appDir = app("app-fields-prop");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, show(result)).toEqual([]);
    expect(fileOf(result.files, "views.tsx")).toContain('fields={["name","role"]}');
  });

  it("still reports a form that forgot its submit, at that section", async () => {
    // What the removed NOVA1002 protected. A field list on a component with no `fields`
    // prop is now the ordinary prop mismatch it always was — reported by TypeScript at
    // the section's own line rather than asserted by nova from the key's name.
    const appDir = app("app-fields-prop");
    edit(appDir, "{ fields: [name, role] }", "\n          fields:\n            - TextField: { name: date }");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok, show(result)).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, show(result)).toBeDefined();
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
    expect(bad!.line).toBe(4);
  });
});

describe("N8 — the app-root import specifier is computed from the resolved outDir", () => {
  it("emits a resolvable specifier for an absolute outDir", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, {
      ...configFor(appDir),
      outDir: join(appDir, "abs-out"),
    });
    expect(result.diagnostics, show(result)).toEqual([]);
    expect(fileOf(result.files, "handlers.ts")).toContain('from "../data"');
  });

  it("emits a resolvable specifier for an outDir outside the app directory", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, {
      ...configFor(appDir),
      outDir: "../elsewhere/generated",
    });
    expect(result.diagnostics, show(result)).toEqual([]);
    expect(fileOf(result.files, "handlers.ts")).toContain('from "../../app-basic/data"');
  });

  it("does not depend on the process working directory", () => {
    // `appRel` used to be `relative(config.outDir, ".")` — relative to cwd, not to the
    // app. The two coincide only for an in-app outDir reached from the repo root.
    const cfg = { ...inPlace, outDir: "generated" };
    const resolvedApp = resolvedFixture("app-basic", cfg);
    const pages = emitPages(resolvedApp, cfg).text;
    const views = emitViews(resolvedApp, cfg).text;
    expect(pages).toContain('from "./views"');
    expect(views).toContain('from "./runtime"');
  });
});
