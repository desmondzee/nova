import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { emitRuntime } from "../src/compile/emit/index.js";
import { compileApp } from "../src/compile/index.js";
import { loadSpecFile } from "../src/compile/load.js";
import { resolveApp } from "../src/compile/resolve.js";
import { validate } from "../src/schema/validate.js";

// Four defects that a typecheck cannot see and that only appear when generated output is
// actually *run* inside a React Server Components host, under a mount prefix. Every test
// here fails against the code that shipped before it.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturesDir = here("./fixtures/");

const dirs: string[] = [];

/** A throwaway copy of one fixture app, with the catalog and tsconfigs beside it. */
function app(name: string): string {
  const root = mkdtempSync(join(fixturesDir, "tmp-host-"));
  dirs.push(root);
  cpSync(join(fixturesDir, name), join(root, name), { recursive: true });
  cpSync(join(fixturesDir, "tsconfig.json"), join(root, "tsconfig.json"));
  cpSync(join(fixturesDir, "tsconfig.strict.json"), join(root, "tsconfig.strict.json"));
  cpSync(join(fixturesDir, "catalog"), join(root, "catalog"), { recursive: true });
  return join(root, name);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui", "../catalog/forms"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.json"),
});

const strict = (appDir: string): NovaConfig => ({
  ...configFor(appDir),
  tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
});

const fileOf = (files: { name: string; text: string }[], name: string) =>
  files.find((f) => f.name === name)!.text;

/** The same config, aimed at the fixtures in place rather than at a copy of one. */
const inPlace = configFor(join(fixturesDir, "app"));

/** Resolve a fixture without compiling it — enough to emit one file and read it back. */
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

describe("the route map is readable from a server component", () => {
  // §3.2 of the integration report: `pages.tsx` carried a module-level "use client", so a
  // server module importing it received client *references* rather than values —
  // `Object.keys(pages)` was `[]` and the host 404'd every route with no error at all.
  it('emits the route map from a module with no "use client", and the components from one that has it', async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);

    const pages = fileOf(result.files, "pages.tsx");
    const views = fileOf(result.files, "views.tsx");

    // The map module is what the host reads from a server component.
    expect(pages).not.toContain("use client");
    expect(pages).toContain("export const pages:");
    // No titles map: `title:` reaches `config.shell` inside the page now.
    expect(pages).not.toContain("titles");
    expect(pages).toContain('"/": Page_0,');
    expect(pages).toContain('from "./views"');
    // …and holds no JSX of its own, so nothing in it can need the client.
    expect(pages).not.toMatch(/<[A-Z]/);

    // The components module is the client half, and only it.
    expect(views).toContain('"use client";');
    expect(views).toContain("export function Page_0(");
    expect(views).toContain("<Table");
    expect(views).not.toContain("export const pages");
    expect(views).not.toContain("export const titles");
  });

  it("evaluates the emitted route map without evaluating any client component", async () => {
    // The strongest form of the assertion above: pages.tsx's exports must survive being
    // read as plain data. Its only import is ./views, stubbed here with one function per
    // page — exactly what a client reference stands in for in a real RSC host.
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    const stub = { Page_0: () => null, Page_1: () => null };
    const pages = evaluateModule(fileOf(result.files, "pages.tsx"), (m) => {
      if (m === "./views") return stub;
      throw new Error(`unexpected import ${m}`);
    }) as { pages: Record<string, unknown> };
    expect(Object.keys(pages.pages).sort()).toEqual(["/", "/trip/:id"]);
    expect(pages.pages["/"]).toBe(stub.Page_0);
  });
});

describe("the runtime survives server-side rendering", () => {
  // §3.3: `useFilters` and `useSort` read `window.location.search` inside their
  // `useState` initialisers. A "use client" component is still server-rendered on first
  // paint, so every page with a filter or a sortable section died with
  // `ReferenceError: window is not defined` before it could render anything.
  //
  // Run rather than inspected: the emitted runtime is transpiled and evaluated in this
  // Node process — which has no `window` — against a React stub that does what React's
  // server renderer does, namely run the hooks and never run an effect.
  const react = () => ({
    useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useRef: (value: unknown) => ({ current: value }),
  });

  const runtimeOf = (fixture: string) =>
    evaluateModule(
      emitRuntime(resolvedFixture(fixture, inPlace), inPlace).text,
      (m) => {
        if (m === "react") return react();
        throw new Error(`unexpected import ${m}`);
      },
    ) as {
      useFilters?: (d: Record<string, string>) => Record<string, string>;
      useSort?: () => { value: unknown };
    };

  it("seeds useFilters from the declared defaults with no window present", () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    const { useFilters } = runtimeOf("app-basic");
    expect(useFilters).toBeDefined();
    expect(() => useFilters!({ month: "2026-08" })).not.toThrow();
    expect(useFilters!({ month: "2026-08" }).month).toBe("2026-08");
  });

  it("seeds useSort unsorted with no window present", () => {
    const { useSort } = runtimeOf("app-sort");
    expect(useSort).toBeDefined();
    expect(() => useSort!()).not.toThrow();
    expect(useSort!().value).toBeNull();
  });
});

describe("loader and action URLs carry the host's mount prefix", () => {
  // §3.1: the fetch paths were absolute literals, so an app mounted at
  // /api/apps/<slug>/* 404'd on every request it made.
  it("prefixes the client's loader and action URLs with basePath, and leaves handler keys alone", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, {
      ...strict(appDir),
      basePath: "/api/apps/trips",
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const views = fileOf(result.files, "views.tsx");
    expect(views).toContain('useLoader<Rows, RowsInput>("/api/apps/trips/_data/rows"');
    expect(views).toContain('useAction("/api/apps/trips/_actions/saveTrip")');
    // Handler map keys are relative to whatever mounts the map, so they do not move.
    const handlers = fileOf(result.files, "handlers.ts");
    expect(handlers).toContain('"GET /_data/rows"');
    expect(handlers).toContain('"POST /_actions/saveTrip"');
    expect(handlers).not.toContain("/api/apps/trips");
  });

  it("keeps today's paths for a host that declares no prefix", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, configFor(appDir));
    const views = fileOf(result.files, "views.tsx");
    expect(views).toContain('useLoader<Rows, RowsInput>("/_data/rows"');
    expect(views).toContain('useAction("/_actions/saveTrip")');
  });

  it("changes the input stamp, because it changes the output", async () => {
    const appDir = app("app-actions");
    const plain = await compileApp(appDir, configFor(appDir), { write: false });
    const prefixed = await compileApp(
      appDir,
      { ...configFor(appDir), basePath: "/api/apps/trips" },
      { write: false },
    );
    const stamp = (files: { name: string; text: string }[]) =>
      fileOf(files, "views.tsx").split("\n")[0];
    expect(stamp(prefixed.files)).not.toBe(stamp(plain.files));
  });
});

describe("an action refreshes the loaders it invalidates", () => {
  // §3.4: after a successful submit the saved row did not appear until a manual reload,
  // and the spec had no way to say otherwise.
  it("re-reads the named loader after a successful submit, clean under the strict host", async () => {
    const appDir = app("app-refresh");
    const result = await compileApp(appDir, strict(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = fileOf(result.files, "views.tsx");
    expect(views).toContain(
      'const saveTripForm = useForm<SaveTripInput>("/_actions/saveTrip", { "date": "", "km": 0, "purpose": "" }, { refresh: () => { trips.reload(); } });',
    );
    // Consumed by nova, never forwarded: a form shell declares no `refreshes` prop.
    expect(views).not.toContain("refreshes=");
    const runtime = fileOf(result.files, "runtime.tsx");
    expect(runtime).toContain("reload");
  });

  it("reports a refreshes naming a loader the page does not bind, at the spec line", async () => {
    const appDir = app("app-refresh");
    const specFile = join(appDir, "app.yaml");
    writeFileSync(
      specFile,
      readFileSync(specFile, "utf8").replace("refreshes: [trips]", "refreshes: [tirps]"),
    );
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA1012"]);
    const bad = result.diagnostics[0]!;
    expect(bad.file).toBe(specFile);
    expect(bad.message).toContain("tirps");
    expect(bad.line).toBe(6);
  });

  it("bumps the loader's own request when reload is called", () => {
    // The hook half, run rather than read: reload has to change something useLoader's
    // effect depends on, or naming a loader in `refreshes:` refreshes nothing.
    const text = emitRuntime(
      resolvedFixture("app-refresh", inPlace),
      inPlace,
    ).text;
    expect(text).toContain("reload");
    const deps = text.split("\n").find((l) => l.includes("}, [path, key"));
    expect(deps).toBeDefined();
    expect(deps).toContain("nonce");
  });
});

describe("states.empty", () => {
  it("is optional, because no generated page renders it", async () => {
    const appDir = app("app-basic");
    const { empty: _empty, ...states } = configFor(appDir).states;
    const result = await compileApp(appDir, { ...configFor(appDir), states });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is still checked against the catalog when it is given", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, {
      ...configFor(appDir),
      states: { loading: "Loading", error: "ErrorNotice", empty: "Nonexistent" },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("NOVA2001");
  });
});

/**
 * Transpile one emitted module and run it in this process, resolving its imports through
 * `load`. Enough to answer "does this module survive being evaluated where a browser
 * global does not exist", which is the one question a typecheck cannot answer.
 */
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
