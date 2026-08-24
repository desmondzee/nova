import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { emitContract, emitHandlers, emitPages, emitRuntime, emitTypes } from "../src/compile/emit/index.js";
import { hooksUsed } from "../src/compile/emit/pages.js";
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

/** Resolve any fixture app, for cases app-basic cannot express. */
function resolvedFixture(name: string, cfg: NovaConfig = config) {
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

/** Config including the second fixture catalog, for specs that use forms/actions. */
const withForms: NovaConfig = { ...config, components: ["../catalog/ui", "../catalog/forms"] };

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

  it("climbs one '../' per outDir path segment, not a hardcoded single level", () => {
    // outDir nested two levels deep ("src/generated") needs two "../" to reach data.ts
    // at the app root, not the one that's correct only for a one-level outDir like
    // "generated". Exercises the same bug class as pages.ts's "../compute" import and
    // handlers.ts/contract.ts's "../data"/"../actions" imports (see appRel in types.ts).
    const { text } = emitTypes(resolved(), { ...config, outDir: "src/generated" });
    expect(text).toContain('import type * as data from "../../data";');
  });

  it("treats a leading './' in outDir as the same single level as no prefix", () => {
    // Regression: a hand-split appRel (`outDir.split(/[\\/]+/).filter(Boolean)`) counts
    // "." as its own path segment, so "./generated" — an entirely ordinary way to spell
    // "generated" — produced "../../data" instead of "../data". specifierFromOutDir
    // (resolve.ts), which goes through node:path's join/relative, already got this
    // right; appRel must agree with it rather than silently diverging again.
    const { text } = emitTypes(resolved(), { ...config, outDir: "./generated" });
    expect(text).toContain('import type * as data from "../data";');
    expect(text).not.toContain('"../../data"');
  });

  it("treats a trailing slash in outDir as the same single level as no suffix", () => {
    const { text } = emitTypes(resolved(), { ...config, outDir: "generated/" });
    expect(text).toContain('import type * as data from "../data";');
  });
});

describe("emitRuntime", () => {
  it("emits the hooks generated pages depend on and imports nothing from nova", () => {
    // Re-valued when emitRuntime started reading its arguments. app-basic binds loaders
    // and reads a filter, but has no action binding, so `useAction` is now correctly
    // absent — the assertion is the same one, applied to the hooks this app's pages.tsx
    // actually imports rather than to all three unconditionally.
    const { text } = emitRuntime(resolved(), config);
    for (const hook of ["useLoader", "useFilters"]) {
      expect(text).toContain(`export function ${hook}`);
    }
    expect(text).not.toContain("@light/nova");
  });

  it("omits a hook no page imports", () => {
    // 43 of runtime.tsx's 116 lines were useAction, shipped into every app whether or
    // not the spec bound a single action. The type it declares goes with it.
    const { text } = emitRuntime(resolved(), config);
    expect(text).not.toContain("useAction");
    expect(text).not.toContain("ActionState");
    expect(text).not.toContain("window.confirm");
  });

  it("emits an empty module when the spec needs no hook at all", () => {
    // app-filters-only declares a filter that nothing reads and binds no loader, so
    // pages.tsx imports nothing from ./runtime. Emitting a bare `import * as React`
    // here would fail a host with noUnusedLocals.
    const { text } = emitRuntime(resolvedFixture("app-filters-only"), config);
    expect(text).toContain("export {};");
    expect(text).not.toContain('import * as React');
    expect(text).not.toContain("export function use");
  });

  it("emits exactly the hooks a page imports, and no others, as the surface grows", () => {
    // The standing rule: every emitted line is reachable from a generated app. Each
    // interaction added to the format is another hook that must not ride along into an
    // app that never says the word. Asserted by exports rather than by substring so a
    // new hook has to be added here deliberately.
    const exportsOf = (text: string) =>
      [...text.matchAll(/^export function (\w+)/gm)].map((m) => m[1]).sort();
    expect(exportsOf(emitRuntime(resolved(), config).text)).toEqual(["useFilters", "useLoader"]);
    expect(exportsOf(emitRuntime(resolvedFixture("app-form", withForms), withForms).text)).toEqual([
      "useAction",
      "useFilters",
      "useForm",
      "useLoader",
    ]);
    expect(exportsOf(emitRuntime(resolvedFixture("app-sort", withForms), withForms).text)).toEqual([
      "useLoader",
      "useSort",
    ]);
    expect(exportsOf(emitRuntime(resolvedFixture("app-zeroparam"), config).text)).toEqual([
      "useLoader",
    ]);
  });

  it("keeps a hook that pages.tsx does import", () => {
    // Re-valued from a hand-patched `{ ...app, actions: ["saveTrip"] }` to a real fixture
    // whose spec binds an action to a prop. `useAction` is now decided by whether any
    // page emits a `useAction(` call, not by app.actions being non-empty — a form's
    // action is submitted through useForm, and `pages.tsx` imports no useAction for it.
    const { text } = emitRuntime(resolvedFixture("app-actions", withForms), withForms);
    expect(text).toContain("export function useAction");
  });

  it("emits useForm, and the useAction it submits through, only for an app with a form", () => {
    const { text } = emitRuntime(resolvedFixture("app-form", withForms), withForms);
    expect(text).toContain("export function useForm");
    expect(text).toContain("export function useAction");
    // And nothing else: app-form binds no action to a plain prop, so the only reason
    // useAction is here at all is that useForm submits through it.
    expect(resolvedFixture("app-form", withForms).actions).toEqual(["saveTrip"]);
    expect(hooksUsed(resolvedFixture("app-form", withForms)).useAction).toBe(false);
  });
});

describe("emitPages", () => {
  it("imports components from their catalog module and nothing from nova", () => {
    const { text } = emitPages(resolved(), config);
    // "../catalog/ui" (relative to app.yaml) is rewritten by resolveApp to "../../catalog/ui"
    // as seen from APP_DIR/generated, where this import actually ends up. EmptyState is
    // absent: the fixture spec never renders it, and importing an unused component here
    // would fail a host tsconfig with `noUnusedLocals`.
    expect(text).toContain('import { ErrorNotice, Loading, StatCard, Table } from "../../catalog/ui";');
    expect(text).not.toContain("EmptyState");
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

  it("emits each page's title into a titles map rather than discarding it", () => {
    // `title:` was validated, stored on PageSpec and then read by no emitter at all.
    // Nova ships no shell component to render it into (states names only
    // loading/error/empty), so it is emitted as a map the host mounts — the same
    // contract as `pages` and `handlers`.
    const { text } = emitPages(resolved(), config);
    expect(text).toContain("export const titles: Record<string, string> = {");
    expect(text).toContain('"/": "Trips",');
    expect(text).toContain('"/trip/:id": "Trip",');
  });

  it("emits an empty titles map when no page declares a title", () => {
    const app = resolved();
    const untitled = {
      ...app,
      spec: { pages: app.spec.pages.map(({ title: _title, ...rest }) => rest) },
    };
    const { text } = emitPages(untitled, config);
    expect(text).toContain("export const titles: Record<string, string> = {\n};");
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

  it("maps each loader/action binding line to the spec position that referenced it", () => {
    // Before the fix, contract.ts mapped every line to ["loaders", name] / ["actions",
    // name] — paths that don't exist in the YAML document (only "pages" does), so
    // positions.at() silently fell back to the document root for every contract
    // diagnostic. loaderOrigins/actionOrigins (resolve.ts) instead record the first
    // spec path that actually referenced the loader/action.
    const app = resolved();
    const { map, text } = emitContract(app, config);
    const lineNo = text.split("\n").findIndex((l) => l.includes("const _trips:")) + 1;
    expect(map.get(lineNo)).toEqual(app.loaderOrigins.trips);
    expect(app.loaderOrigins.trips).not.toEqual(["loaders", "trips"]);
  });
});

describe("zero-parameter loaders", () => {
  const zeroParamSpecFile = here("./fixtures/app-zeroparam/app.yaml");
  const zeroParamConfig: NovaConfig = { ...config, tsconfigPath: here("./fixtures/tsconfig.json") };

  function resolvedZeroParam() {
    const source = readFileSync(zeroParamSpecFile, "utf8");
    const { raw, positions } = loadSpecFile(zeroParamSpecFile, source);
    const { spec } = validate(raw, positions);
    const { catalog } = readCatalogs(zeroParamConfig, zeroParamSpecFile);
    return resolveApp(spec!, {
      config: zeroParamConfig,
      appDir: dirname(zeroParamSpecFile),
      specFile: zeroParamSpecFile,
      catalog,
      positions,
    }).resolved!;
  }

  it("resolves the loader's declared parameter count", () => {
    expect(resolvedZeroParam().loaderArity).toEqual({ status: 0 });
  });

  it("gives a zero-parameter loader a plain Input type instead of indexing an empty tuple", () => {
    // Parameters<typeof data.status>[0] is a type error for a zero-parameter loader —
    // there is no element at index 0 of an empty tuple.
    const { text } = emitTypes(resolvedZeroParam(), zeroParamConfig);
    expect(text).toContain("export type StatusInput = Record<string, never>;");
    expect(text).not.toContain("Parameters<typeof data.status>[0]");
  });

  it("calls a zero-parameter loader's handler with no argument", () => {
    const { text } = emitHandlers(resolvedZeroParam(), zeroParamConfig);
    expect(text).toContain("await data.status()");
    expect(text).not.toContain("data.status(input");
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
