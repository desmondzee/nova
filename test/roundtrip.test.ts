import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../src/compile/config.js";
import { compileApp } from "../src/compile/index.js";
import { loadSpecFile } from "../src/compile/load.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturesDir = here("./fixtures/");

const dirs: string[] = [];

// Scratch trees are created inside the repo (under test/fixtures/), not the OS tmpdir.
// compileApp typechecks its emitted output, and pages.tsx imports "react" — Node
// resolves that by walking up from the file's location, and it would never reach this
// repo's node_modules starting from /tmp. Each fixture subtree is copied individually
// (rather than one recursive copy of "fixtures" into itself, which Node refuses) —
// same pattern as test/compile.test.ts and test/emit.test.ts.
function app(name: string): string {
  const root = mkdtempSync(join(fixturesDir, "tmp-app-"));
  dirs.push(root);
  cpSync(join(fixturesDir, name), join(root, name), { recursive: true });
  cpSync(join(fixturesDir, "tsconfig.json"), join(root, "tsconfig.json"));
  cpSync(join(fixturesDir, "tsconfig.strict.json"), join(root, "tsconfig.strict.json"));
  // A single, realistic copy: catalog lives as a sibling of the app directory, exactly
  // where readCatalogs (resolving "../catalog/ui" relative to app.yaml) validates it.
  // resolveApp rewrites that specifier to be correct as seen from generated/ before it
  // is ever written into emitted code, so no second copy nested under the app is needed.
  cpSync(join(fixturesDir, "catalog"), join(root, "catalog"), { recursive: true });
  return join(root, name);
}
/** Rewrite one fragment of a scratch app's spec, asserting it was there to rewrite. */
function edit(appDir: string, from: string, to: string): void {
  const specFile = join(appDir, "app.yaml");
  const source = readFileSync(specFile, "utf8");
  expect(source).toContain(from);
  writeFileSync(specFile, source.replace(from, to));
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.json"),
});

// Catalog components for prop shapes ui.tsx has none for: children, a bound action
// callback, and a bound compute function. A second catalog module rather than more
// exports on ui.tsx, so nothing already asserted about ui.tsx's export list moves.
const withForms = (appDir: string): NovaConfig => ({
  ...configFor(appDir),
  components: ["../catalog/ui", "../catalog/forms"],
});

describe("actions, compute bindings and nested children", () => {
  // All three worked end to end and none had a single test. app-actions exercises them
  // together, through compileApp, so the assertions below are backed by a real
  // typecheck of the emitted output rather than string matching alone.

  it("compiles an app with an action, a compute binding and nested children", async () => {
    // Under the strict host tsconfig (noUnusedLocals, noUnusedParameters,
    // noUncheckedIndexedAccess), since these three features had no coverage at any
    // strictness level.
    const appDir = app("app-actions");
    const result = await compileApp(appDir, {
      ...withForms(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("binds an action to a component prop and emits its POST handler", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, withForms(appDir));
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain(
      'const saveTripAction = useAction<SaveTripInput, Awaited<ReturnType<SaveTrip>>>("/_actions/saveTrip");',
    );
    expect(views).toContain("onSubmit={saveTripAction.run}");
    // The action's own input type, imported for the purpose: an action bound to a plain
    // prop used to reach the component as a `(input: unknown) => …`, which every callback
    // shape accepted. Its own type comes with it, because `run` now resolves the action's
    // own result rather than a boolean nova reduced it to. Asserted as the whole import
    // statement: every type views.tsx names comes from ./types in one line, so this pins
    // both halves of the action's pair *and* that nothing else rode along.
    expect(views).toContain(
      'import type { Distance, DistanceInput, Rows, RowsInput, SaveTrip, SaveTripInput } from "./types";',
    );
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).toContain('"POST /_actions/saveTrip"');
    // The body is parsed through `body(req)` rather than a bare `await req.json()`,
    // which is what turns a malformed body into a 400 instead of a 500.
    expect(handlers).toContain("actions.saveTrip((await body(req)) as never)");
    // __contract.ts binds the loaders and nothing else. An action's binding was
    // `const _saveTrip: SaveTrip = actions.saveTrip` where `SaveTrip` *is*
    // `typeof actions.saveTrip` — an expression assigned to its own type, which no
    // assignability rule can reject. With it gone the `actions` import has to go too, or
    // every app would carry an unused import into a host with `noUnusedLocals`.
    const contract = result.files.find((f) => f.name === "__contract.ts")!.text;
    expect(contract).toContain("const _rows: (input: RowsInput) => Promise<Rows> = data.rows;");
    expect(contract).not.toContain("import * as actions");
    expect(contract).not.toContain("_saveTrip");
    // useAction is now emitted because this app binds one — and only because of that.
    const runtime = result.files.find((f) => f.name === "runtime.tsx")!.text;
    expect(runtime).toContain("export function useAction");
  });

  it("passes a compute function through by reference, with no HTTP handler", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, withForms(appDir));
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain('import * as compute from "../compute";');
    expect(views).toContain("format={compute.formatKm}");
    // §6.4: pure, bundled into the client. No endpoint, and no entry in handlers.ts.
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).not.toContain("formatKm");
    expect(handlers).not.toContain("compute");
  });

  it("nests a section's children inside its element, indented", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, withForms(appDir));
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    const lines = views.split("\n");
    const open = lines.findIndex((l) => l.includes("<Panel "));
    const close = lines.findIndex((l) => l.includes("</Panel>"));
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(lines[open]!.trimEnd().endsWith(">")).toBe(true);
    expect(lines[open]).not.toContain("/>");
    const inner = lines.slice(open + 1, close);
    expect(inner.some((l) => l.includes("<Table "))).toBe(true);
    expect(inner.some((l) => l.includes("<Formatter "))).toBe(true);
    expect(inner.some((l) => l.includes("<ActionButton "))).toBe(true);
    // Children are indented one level deeper than the element that holds them.
    const indent = (l: string) => l.length - l.trimStart().length;
    for (const line of inner) expect(indent(line)).toBe(indent(lines[open]!) + 2);
  });

  it("maps a nested child's generated line back to its own spec path", async () => {
    // The line map has to descend through `children:` too, or a type error inside a
    // nested section reports against the parent — or, worse, nothing at all.
    const appDir = app("app-actions");
    const result = await compileApp(appDir, withForms(appDir));
    const file = result.files.find((f) => f.name === "views.tsx")!;
    const lineNo = file.text.split("\n").findIndex((l) => l.includes("<Formatter ")) + 1;
    // Re-valued: the path now carries the parent's own YAML key, because that is where
    // the document holds the children — `sections[0].Panel.children[1]`. Without it,
    // positions.at() found no node at ["…","sections",0,"children",1] and fell back to
    // the parent section, so every diagnostic inside a nested section was reported
    // against its container's line rather than its own.
    expect(file.map.get(lineNo)).toEqual(["pages", "/", "sections", 0, "Panel", "children", 1]);
    const positionOf = (path: (string | number)[]) =>
      loadSpecFile(join(appDir, "app.yaml"), readFileSync(join(appDir, "app.yaml"), "utf8")).positions.at(
        path,
      );
    expect(positionOf(file.map.get(lineNo)!).line).toBe(13);
    expect(positionOf(["pages", "/", "sections", 0]).line).toBe(7);
  });
});

describe("table sorting", () => {
  it("hands sort state to the table and keeps it in the URL, clean under the strict host", async () => {
    const appDir = app("app-sort");
    const result = await compileApp(appDir, {
      ...withForms(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain("const sortState = useSort();");
    expect(views).toContain("onSort={sortState.set}");
    expect(views).toContain("sort={sortState.value}");
    // `sortable` is forwarded too — the table decides which headers are clickable.
    expect(views).toContain('sortable={["date","km"]}');
    const runtime = result.files.find((f) => f.name === "runtime.tsx")!.text;
    expect(runtime).toContain("export function useSort");
    expect(runtime).toContain("window.history.replaceState");
  });

  it("emits no sort machinery for an app with no sortable section", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    for (const name of ["runtime.tsx", "views.tsx"]) {
      expect(result.files.find((f) => f.name === name)!.text).not.toContain("useSort");
    }
  });
});

describe("forms", () => {
  /** The fixture spec with one substitution applied, written back into the copied app. */
  it("compiles a form clean under the strict host tsconfig", async () => {
    const appDir = app("app-form");
    const result = await compileApp(appDir, {
      ...withForms(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("holds the form's values in useForm, typed by the action's own input", async () => {
    const appDir = app("app-form");
    const result = await compileApp(appDir, withForms(appDir));
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain(
      'const saveTripForm = useForm<SaveTripInput>("/_actions/saveTrip", { "date": "", "km": 0, "purpose": "" }, { confirm: "Save this trip?" });',
    );
    const types = result.files.find((f) => f.name === "types.ts")!.text;
    expect(types).toContain(
      "export type SaveTripInput = Parameters<typeof actions.saveTrip>[0];",
    );
  });

  it("wires each field's value, change and error to the form state", async () => {
    const appDir = app("app-form");
    const result = await compileApp(appDir, withForms(appDir));
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain(
      '<NumberField error={saveTripForm.errors["km"]} label={"Distance (km)"} name={"km"} onChange={(value) => saveTripForm.set("km", value)} value={saveTripForm.values["km"]} />',
    );
    // The form shell gets the submit callback, the busy flag and the form-level error.
    expect(views).toContain(
      "<Form busy={saveTripForm.busy} error={saveTripForm.error} onSubmit={saveTripForm.submit}>",
    );
    // `initial` is nova's, not the component's: it seeds useForm and is not forwarded.
    expect(views).not.toContain("initial=");
    // A form's action still gets its POST handler.
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).toContain('"POST /_actions/saveTrip"');
  });

  it("discovers a loader bound by a field's own prop", async () => {
    // Every walker that finds loaders, filters and route params has to descend into
    // `fields:` as well as `children:`. Miss it and the page references `purposes.value`
    // with no `const purposes = useLoader(...)` ever declared.
    const appDir = app("app-form");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain(
      'const purposes = useLoader<Purposes, PurposesInput>("/_data/purposes", { "month": filters["month"] });',
    );
    expect(views).toContain("options={purposes.value}");
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).toContain('"GET /_data/purposes"');
  });

  it("reports a field naming a key the action does not accept, at that field's line", async () => {
    // The whole point of the form surface: `name:` is a key of the action's input type,
    // checked by TypeScript, not a string that fails at runtime.
    const appDir = app("app-form");
    edit(appDir, "name: km,", "name: kmm,");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const detail = JSON.stringify(result.diagnostics, null, 2);
    // Reported twice over, at two useful places. On the `- NumberField:` field entry
    // itself (line 10): `values["kmm"]`, `set("kmm", …)` and `errors["kmm"]` are all
    // indexed against the action's input type.
    const atField = result.diagnostics.filter((d) => d.code === "NOVA3001" && d.line === 12);
    expect(atField.length, detail).toBeGreaterThan(0);
    for (const d of atField) {
      expect(d.file).toBe(join(appDir, "app.yaml"));
      expect(d.message).toContain("kmm");
    }
    // And on the `- Form:` section (line 5), where the assembled initial values no
    // longer match the action's input.
    const atForm = result.diagnostics.filter((d) => d.code === "NOVA3001" && d.line === 7);
    expect(atForm.length, detail).toBeGreaterThan(0);
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });

  it("reports a form that does not cover every required key of the action's input", async () => {
    const appDir = app("app-form");
    edit(appDir, "            - SelectField: { name: purpose, label: Purpose, options: data#purposes }\n", "");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.message).toContain("purpose");
    // Reported at the `- Form:` section, which is what is incomplete.
    expect(bad!.line).toBe(7);
  });

  it("reports a field component whose value type does not match the input's", async () => {
    const appDir = app("app-form");
    edit(appDir, "- NumberField: { name: km,", "- TextField: { name: km,");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.line).toBe(12);
  });

  it("emits useForm only for an app that has a form", async () => {
    const appDir = app("app-form");
    const withFormRuntime = (await compileApp(appDir, withForms(appDir))).files.find(
      (f) => f.name === "runtime.tsx",
    )!.text;
    expect(withFormRuntime).toContain("export function useForm");
    // useForm submits through useAction, so that hook comes with it…
    expect(withFormRuntime).toContain("export function useAction");
    // …but views.tsx must not import useAction, which no page here calls directly.
    const views = (await compileApp(appDir, withForms(appDir))).files.find(
      (f) => f.name === "views.tsx",
    )!.text;
    expect(views).toContain("useForm");
    expect(views).not.toContain("useAction");

    const plain = app("app-basic");
    const plainRuntime = (await compileApp(plain, configFor(plain))).files.find(
      (f) => f.name === "runtime.tsx",
    )!.text;
    expect(plainRuntime).not.toContain("useForm");
  });
});

describe("confirmation before a destructive action", () => {
  it("passes the spec's confirm text into useAction, and typechecks under the strict host", async () => {
    // §5 lists confirmation as an interaction the format owns, and useAction's runtime
    // half has always accepted `opts.confirm` — but `validate` had no `confirm:` key, so
    // every generated `useAction` call was emitted with one argument and the guard was
    // unreachable from any spec.
    const appDir = app("app-confirm");
    const result = await compileApp(appDir, {
      ...withForms(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain(
      'const deleteTripAction = useAction<DeleteTripInput, Awaited<ReturnType<DeleteTrip>>>("/_actions/deleteTrip", { confirm: "Delete this trip?" });',
    );
    // Consumed by nova rather than forwarded — ActionButton declares no `confirm` prop.
    expect(views).not.toContain("confirm={");
  });

  it("emits useAction with one argument when no section asks to confirm", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, withForms(appDir));
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain(
      'const saveTripAction = useAction<SaveTripInput, Awaited<ReturnType<SaveTrip>>>("/_actions/saveTrip");',
    );
  });
});

describe("filter writes", () => {
  it("emits filters.set for a write binding and typechecks under the strict host", async () => {
    // `useFilters` has always returned a `set`, kept a popstate listener and written back
    // to the query string — and no emitter could produce a call to it, so a generated
    // page could display a filter and feed it to a loader but never change one.
    const appDir = app("app-filter-write");
    const result = await compileApp(appDir, {
      ...withForms(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain("value={filters.month}");
    expect(views).toContain('onChange={(value: string) => filters.set("month", value)}');
    // A page whose only filter use is a write still needs the local and the hook.
    expect(views).toContain("const filters = useFilters(");
    const runtime = result.files.find((f) => f.name === "runtime.tsx")!.text;
    expect(runtime).toContain("export function useFilters");
  });

  it("reports a write to a filter the page does not declare", async () => {
    const appDir = app("app-filter-write");
    const specFile = join(appDir, "app.yaml");
    writeFileSync(
      specFile,
      readFileSync(specFile, "utf8").replace("filters.month.set", "filters.mnoth.set"),
    );
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2006"]);
  });
});

describe("round trip", () => {
  it("emits output that typechecks clean for a correct spec", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("emits a page per route", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    const pages = result.files.find((f) => f.name === "pages.tsx")!.text;
    expect(pages).toContain('"/": Page_0,');
    expect(pages).toContain('"/trip/:id": Page_1,');
  });

  it("reports a prop/loader type mismatch at the YAML line, not the generated line", async () => {
    const appDir = app("app-broken");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const mismatch = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(mismatch).toBeDefined();
    expect(mismatch!.file).toBe(join(appDir, "app.yaml"));
    // The emitter maps whole JSX elements, so the origin is the `- Table:` section
    // node on line 6 — not the `rows:` line that supplied the offending prop.
    expect(mismatch!.line).toBe(6);
    expect(mismatch!.related?.[0]?.file).toContain("views.tsx");
  });

  it("never leaves a diagnostic pointing only at generated code", async () => {
    const appDir = app("app-broken");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });

  it("compiles clean on a host tsconfig with noUnusedLocals and noUnusedParameters", async () => {
    // A host that turns these on is well within its rights, and every generated app
    // must compile there: an unconditionally-imported hook or state component that a
    // particular spec never uses would otherwise fail as "declared but its value is
    // never read", reported as NOVA3002 ("likely a nova bug") against the author's
    // perfectly reasonable spec.
    const appDir = app("app-basic");
    const config: NovaConfig = {
      ...configFor(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    };
    const result = await compileApp(appDir, config);
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("compiles clean under noUnusedLocals for a page with filters and no loader", async () => {
    // app-basic (above) has both filters and a loader on the same page, so it can't
    // catch a `const filters = useFilters(...)` that nothing reads: filters only feed a
    // loader's query object today, so a page with filters but no loader must not
    // declare the local at all, or this fails the exact same way item 1 did.
    const appDir = app("app-filters-only");
    const config: NovaConfig = {
      ...configFor(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    };
    const result = await compileApp(appDir, config);
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).not.toContain("useFilters");
    expect(views).not.toContain("const filters");
  });

  it("resolves app-root imports correctly under a nested outDir", async () => {
    // specifierFromOutDir (resolve.ts) already recomputes catalog/local-component
    // specifiers relative to outDir. The hand-written "../data"/"../actions"/"../compute"
    // imports in types.ts, handlers.ts, contract.ts (and the "../compute" import in
    // pages.ts) must track outDir's actual depth the same way, or they stay wrong for
    // any outDir nested more than one level below the app root.
    const appDir = app("app-basic");
    const config: NovaConfig = { ...configFor(appDir), outDir: "src/generated" };
    const result = await compileApp(appDir, config);
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const types = result.files.find((f) => f.name === "types.ts")!.text;
    expect(types).toContain('from "../../data"');
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).toContain('from "../../data"');
    const contract = result.files.find((f) => f.name === "__contract.ts")!.text;
    expect(contract).toContain('from "../../data"');
  });

  it("calls a zero-parameter loader with no argument", async () => {
    // Parameters<typeof data.status>[0] is `undefined` for a zero-parameter loader.
    // handlers.ts must not call it with an argument anyway — a loader with no inputs
    // is a normal pattern, not a spec error.
    const appDir = app("app-zeroparam");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).toContain("respond(() => data.status())");
    expect(handlers).not.toContain("data.status(input");
  });

  it("supplies a loader input from a route param, not from filters alone", async () => {
    // §6.2: "Loader inputs are supplied from route params and filter values." This page
    // declares no filters, so if params were still dropped the query would be `{}` and
    // `trip(input: { id: string })` would be called with nothing.
    const appDir = app("app-route-param");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain('const params_id = params["id"] ?? "";');
    expect(views).toContain('useLoader<Trip, TripInput>("/_data/trip", { "id": params_id });');
  });

  it("reports a loader input that neither params nor filters supply, at the spec line", async () => {
    // Previously silent: the query object was typed `Record<string, string>`, so a
    // loader declaring `{ month: string; region: string }` on a page with no filters
    // compiled to `useLoader<Summary>("/_data/summary", {})` with zero diagnostics.
    const appDir = app("app-missing-input");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const missing = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(missing, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(missing!.file).toBe(join(appDir, "app.yaml"));
    // The `- StatCard: { ..., value: data#summary }` section that named the loader.
    expect(missing!.line).toBe(4);
    expect(missing!.message).toContain("month");
    // Not an unmapped "likely a nova bug" diagnostic pointing at generated code.
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });

  it("compiles clean under noUncheckedIndexedAccess for both filter and param access", async () => {
    // The generated `filters["month"]` and `params.id` both produced `string | undefined`
    // under this flag: the first as two unmapped NOVA3002s (a nova bug by the README's
    // own definition), the second as a NOVA3001 the author had no way to satisfy.
    // app-basic exercises both — filters feeding a loader on "/", a route param bound to
    // a `string` prop on "/trip/:id".
    const appDir = app("app-basic");
    const config: NovaConfig = {
      ...configFor(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    };
    const result = await compileApp(appDir, config);
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports a contract-only diagnostic at the spec binding, not app.yaml:1:1", async () => {
    // __contract.ts's `(input: TripsInput) => Promise<Trips> = data.trips` catches a
    // non-async loader (Trips and TripsInput are both derived from data.trips itself,
    // so nothing else about that binding can fail). Before the fix, contract.ts mapped
    // every loader/action line to ["loaders", name] / ["actions", name] — paths that
    // don't exist in the YAML document — so positions.at() fell back to the document
    // root and every contract diagnostic landed at 1:1 regardless of the spec's shape.
    const appDir = app("app-sync-loader");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const mismatch = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(mismatch, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(mismatch!.file).toBe(join(appDir, "app.yaml"));
    expect(mismatch!.line).not.toBe(1);
    expect(mismatch!.col).not.toBe(1);
    // The `rows: data#trips` binding is the only place "trips" is referenced.
    expect(mismatch!.line).toBe(4);
  });
});

describe("a page shell", () => {
  // §8.2 of the re-verify report: sections emitted into a bare `<></>`, so a host had no
  // parent to hang vertical rhythm on and put `mt-4 first:mt-0` inside every catalog
  // component instead — a layout concern pushed into components, invented once per host.

  it("wraps a page's sections, and its loading and error states, in the configured shell", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, {
      ...configFor(appDir),
      shell: "PageShell",
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain('<PageShell title={"Trips"}>');
    expect(views).toContain("</PageShell>");
    expect(views).not.toContain("<>");
    // Re-valued, and to a stronger claim than it made. It asserted that the shell was
    // repeated around the two early returns that stood in for a failed or loading page;
    // there are no early returns any more, so the shell — and the title — is on the one
    // path the page has. What used to blank the whole page now degrades one section:
    expect(views).toContain(
      '{trips.error !== null ? <ErrorNotice>{trips.error}</ErrorNotice> : trips.value === null ? <Loading /> : <Table',
    );
    expect(views).not.toContain("if (error) return");
  });

  it("still emits a bare fragment for a host that configures no shell", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain("<>");
    expect(views).not.toContain("PageShell");
  });

  it("no longer emits a titles map, because title: now has somewhere to go", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    const pages = result.files.find((f) => f.name === "pages.tsx")!.text;
    expect(pages).not.toContain("titles");
  });

  it("reports a shell that no catalog exports", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, { ...configFor(appDir), shell: "NoSuchShell" });
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA2001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.message).toContain("NoSuchShell");
  });
});

describe("a field bound to a union-typed key", () => {
  // §8.3: `SelectField`'s `onChange(value: string)` made `(value) => set("vehicle", value)`
  // infer `string`, which is not assignable to `"car" | "van"` — so the host widened the
  // action's own input to `string` and lost the guarantee the compiler exists to give.

  it("compiles when the field component is generic in its value type", async () => {
    const appDir = app("app-union");
    const result = await compileApp(appDir, {
      ...withForms(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("still rejects an option the union does not contain", async () => {
    const appDir = app("app-union");
    edit(appDir, "                  - { value: van, label: Van }", "                  - { value: lorry, label: Lorry }");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
  });

  it("still rejects a field whose value type is wider than the key's", async () => {
    // The guarantee, stated as a failing case: a plain `string` picker on a union key is
    // a compile error at that field's own line, exactly as it was before.
    const appDir = app("app-union");
    edit(appDir, "            - ChoiceField:", "            - SelectField:");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
  });
});

describe("a computed filter default", () => {
  // §8.4: `default:` took a literal only, so a month filter opened empty rather than on
  // the current month, and a sentinel like `default: current` would have been an untyped,
  // host-specific vocabulary growing one entry at a time.

  it("calls the compute function for the filter's starting value", async () => {
    const appDir = app("app-computed-default");
    const result = await compileApp(appDir, {
      ...configFor(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain('import * as compute from "../compute";');
    expect(views).toContain('const filters = useFilters({ "month": compute.currentMonth() });');
    // Not an HTTP endpoint: a compute function is bundled into the client (§6.4).
    const handlers = result.files.find((f) => f.name === "handlers.ts")!.text;
    expect(handlers).not.toContain("currentMonth");
  });

  it("reports a computed default whose type is not the string a filter holds", async () => {
    const appDir = app("app-computed-default");
    writeFileSync(
      join(appDir, "compute.ts"),
      "export function currentMonth(): number {\n  return 8;\n}\n",
    );
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
    // The page's own `filters:` block, not the document root and not a generated line.
    expect(bad!.line).toBe(5);
  });

  it("reports a compute# name the app does not export", async () => {
    const appDir = app("app-computed-default");
    edit(appDir, "compute#currentMonth", "compute#currentMnoth");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA2004");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.hint).toContain("currentMonth");
  });
});

describe("an action bound outside a form", () => {
  // The survey's finding: `expr()` emits an `actions#x` prop as `xAction.run`, and `run`
  // was declared `(input: unknown) => Promise<boolean>`. An `unknown` parameter is
  // assignable to every callback shape there is, so a per-row action bound to any prop of
  // any component type-checked whatever the component actually passed it — the one
  // non-form action binding was wholly unchecked.

  it("compiles when the action accepts the row the component hands it", async () => {
    const appDir = app("app-row-action");
    const result = await compileApp(appDir, {
      ...withForms(appDir),
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    // The action's own input type is the type argument, and that is the whole mechanism.
    expect(views).toContain(
      'const deleteTripAction = useAction<DeleteTripInput, Awaited<ReturnType<DeleteTrip>>>("/_actions/deleteTrip");',
    );
    expect(views).toContain("onDelete={deleteTripAction.run}");
  });

  it("reports a per-row action whose input the component's callback cannot supply", async () => {
    const appDir = app("app-row-action");
    edit(appDir, "onDelete: actions#deleteTrip", "onDelete: actions#archiveTrip");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
    // The section that bound it, not a generated line. A section's props are emitted as
    // one JSX line, so a section-prop error lands on the section's own line — a field's
    // lands on the field's (below), which is the finer granularity forms need.
    expect(bad!.line).toBe(4);
    expect(bad!.message).toContain("tripId");
  });
});

describe("a generic field component", () => {
  // A generic invoked with no type argument resolves its parameter by inference, and a
  // parameter no supplied prop mentions resolves to something that makes every constraint
  // derived from it vacuous — `BooleanKeys<T>` accepting any string at all. Withdrawing
  // the "props must not be generic" rule is what let a field reach that state.

  it("writes the type argument nova knows, so the key's own type decides", async () => {
    const appDir = app("app-union");
    const result = await compileApp(appDir, withForms(appDir));
    const views = result.files.find((f) => f.name === "views.tsx")!.text;
    expect(views).toContain('<ChoiceField<SaveTripInput["vehicle"]> ');
    // A non-generic field is written exactly as it always was.
    expect(views).toContain('<TextField error=');
  });

  it("reports a field whose component cannot carry the key's type", async () => {
    const appDir = app("app-generic-field");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
    // The field's own line, not the form's and not a generated one.
    expect(bad!.line).toBe(8);
  });

  it("reports a field component asking for a type argument nova does not have", async () => {
    // Two type parameters, one type to give. Emitting it with the second left to
    // inference is exactly the state this fix exists to remove, so it is reported at the
    // field instead — NOVA2012, answered by reading the catalog export and nothing else.
    const appDir = app("app-generic-field");
    edit(appDir, "            - ToggleGroupField:", "            - PairField:");
    const result = await compileApp(appDir, withForms(appDir));
    expect(result.ok).toBe(false);
    const bad = result.diagnostics.find((d) => d.code === "NOVA2012");
    expect(bad, JSON.stringify(result.diagnostics, null, 2)).toBeDefined();
    expect(bad!.file).toBe(join(appDir, "app.yaml"));
    expect(bad!.line).toBe(8);
    expect(bad!.message).toContain("PairField");
  });
});
