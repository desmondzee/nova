import {
  componentKey,
  type FieldSpec,
  type PageSpec,
  type PropValue,
  type SectionSpec,
} from "../../schema/types.js";
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter, type SpecPath } from "./emitter.js";
import { HEADER, appRel, cap, rel, type EmittedFile } from "./types.js";

const PAGES_TYPE =
  "Record<string, React.ComponentType<{ params: Record<string, string> }>>";

const TITLES_TYPE = "Record<string, string>";

/**
 * One endpoint's URL as the *client* calls it: `/_data/trips`, behind whatever prefix
 * the host mounts this app's handler map at.
 *
 * `handlers.ts`'s keys deliberately do not move with it. They are relative to the mount
 * — a host that serves an app at `/api/apps/<slug>/*` matches the remainder of the path
 * against them — so prefixing both halves would double the prefix. Only the fetching
 * half has to know where the app lives.
 */
function urlFor(config: NovaConfig, kind: "_data" | "_actions", name: string): string {
  return `${(config.basePath ?? "").replace(/\/+$/, "")}/${kind}/${name}`;
}

/** Local holding one route param's value, narrowed to `string` exactly once per page. */
const paramLocal = (name: string) => `params_${name}`;

/** Route parameter names declared by a route, in declaration order. */
function routeParamsOf(route: string): string[] {
  return route
    .split("/")
    .filter((s) => s.startsWith(":"))
    .map((s) => s.slice(1));
}

function expr(value: PropValue): string {
  if (value.kind === "literal") return JSON.stringify(value.value);
  const ref = value.ref;
  switch (ref.kind) {
    case "data":
      return [`${ref.name}.value`, ...ref.path].join(".");
    case "actions":
      return `${ref.name}Action.run`;
    case "compute":
      return `compute.${ref.name}`;
    case "param":
      // A page's `params` is `Record<string, string>` (the shape §2 fixes for the pages
      // map), so `params.id` is `string | undefined` under `noUncheckedIndexedAccess`.
      // Every route param a page reads is narrowed once, into a local, at the top of the
      // page function instead — see paramLocal below.
      return paramLocal(ref.name);
    case "filter":
      // A write reaches the component as a setter for that one filter, so the component
      // needs no knowledge of the filter's name. The parameter is annotated rather than
      // left to contextual typing: a prop typed `(value: number) => void` should be a
      // type error at the spec line, not an implicit any.
      return ref.mode === "set"
        ? `(value: string) => filters.set(${JSON.stringify(ref.name)}, value)`
        : `filters.${ref.name}`;
  }
}

/** What nova consumes from a section rather than forwarding: the useAction/useForm opts. */
type ActionOpts = { confirm?: string; refreshes?: string[] };

/**
 * The confirmation and refresh list attached to each action bound on a page, if any.
 *
 * Keyed by action rather than by section because a page hoists one `useAction` per
 * action above every section that binds it; `validate` has already reported any page
 * where two sections disagree (NOVA1010), so the last writer here is the only writer.
 * A form's own `submit:` is deliberately not collected here — a form carries its options
 * on its own `useForm`.
 */
function optionsByAction(sections: SectionSpec[]): Map<string, ActionOpts> {
  const out = new Map<string, ActionOpts>();
  const walk = (list: SectionSpec[]) => {
    for (const s of list) {
      if (s.confirm !== undefined || s.refreshes !== undefined) {
        for (const value of Object.values(s.props)) {
          if (value.kind === "binding" && value.ref.kind === "actions") {
            out.set(value.ref.name, optsOf(s));
          }
        }
      }
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

const optsOf = (s: SectionSpec): ActionOpts => ({
  ...(s.confirm === undefined ? {} : { confirm: s.confirm }),
  ...(s.refreshes === undefined ? {} : { refreshes: s.refreshes }),
});

/**
 * The trailing options argument of a `useAction`/`useForm` call, or "" when the section
 * asks for neither.
 *
 * `refresh` is the whole of the invalidation vocabulary: a successful submission calls
 * `reload()` on each loader the section named, and the loader re-requests. There is no
 * cache, no key space and nothing to configure — the page's own loader locals are
 * already in scope above every action, because loaders are hoisted first.
 */
function optsArg(opts: ActionOpts | undefined): string {
  const parts = [
    ...(opts?.confirm === undefined ? [] : [`confirm: ${JSON.stringify(opts.confirm)}`]),
    ...(opts?.refreshes === undefined || opts.refreshes.length === 0
      ? []
      : [`refresh: () => { ${opts.refreshes.map((n) => `${n}.reload();`).join(" ")} }`]),
  ];
  return parts.length === 0 ? "" : `, { ${parts.join(", ")} }`;
}

/**
 * The route and title maps — a module with **no** `"use client"`.
 *
 * Under React Server Components a server module importing a client module receives
 * client *references*, not values: `Object.keys(pages)` on a `"use client"` module is
 * `[]`, so a host that mounts routes from a server component sees no pages at all and
 * 404s every request without an error to show for it. The maps are data the host reads;
 * the page components are the client half. They cannot live in one module, so they
 * don't — `views.tsx` carries the directive and this file imports from it, which is the
 * same split a hand-written app in an RSC host already uses.
 */
export function emitPages(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER);
  e.line();
  // A type-only import: this module names React's component type and evaluates nothing
  // from it, which is exactly what makes it safe to read from a server component.
  e.line('import type * as React from "react";');
  if (app.spec.pages.length > 0) {
    const names = app.spec.pages.map((_, index) => `Page_${index}`).join(", ");
    e.line(`import { ${names} } from "${rel(config, "./views")}";`);
  }
  e.line();

  e.line(`export const pages: ${PAGES_TYPE} = {`);
  e.indent();
  app.spec.pages.forEach((page, index) => {
    e.line(`${JSON.stringify(page.route)}: Page_${index},`, ["pages", page.route]);
  });
  e.dedent();
  e.line("};");
  e.line();

  // `title:` is a page-level fact with no page-level place to render it: nova ships no
  // components (§2) and `states` names only the loading and error ones, so there is no shell
  // component to hand it to and inventing one would mean new required config for a
  // component every consumer would have to write. It is emitted as a map instead —
  // the same shape, and the same contract, as `pages` and `handlers`: nova emits it,
  // the host mounts it wherever its own layout puts a title. Always emitted, even when
  // empty, so the module's exports do not change shape with the spec.
  e.line(`export const titles: ${TITLES_TYPE} = {`);
  e.indent();
  for (const page of app.spec.pages) {
    if (page.title === undefined) continue;
    e.line(`${JSON.stringify(page.route)}: ${JSON.stringify(page.title)},`, [
      "pages",
      page.route,
      "title",
    ]);
  }
  e.dedent();
  e.line("};");

  return { name: "pages.tsx", text: e.text(), map: e.map() };
}

/** The page components themselves: the `"use client"` half of the emitted pair. */
export function emitViews(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  const byModule = new Map<string, string[]>();
  for (const c of app.components) {
    byModule.set(c.module, [...(byModule.get(c.module) ?? []), c.name]);
  }

  e.line(HEADER);
  e.line('"use client";');
  e.line();
  e.line('import * as React from "react";');
  for (const module of [...byModule.keys()].sort()) {
    const names = [...new Set(byModule.get(module)!)].sort();
    e.line(`import { ${names.join(", ")} } from "${module}";`);
  }
  if (app.computes.length > 0) e.line(`import * as compute from "${appRel(config, "compute")}";`);
  const { useAction, useFilters, useForm, useLoader, useSort } = hooksUsed(app);
  const hooks = [
    ...(useAction ? ["useAction"] : []),
    ...(useFilters ? ["useFilters"] : []),
    ...(useForm ? ["useForm"] : []),
    ...(useLoader ? ["useLoader"] : []),
    ...(useSort ? ["useSort"] : []),
  ];
  if (hooks.length > 0) e.line(`import { ${hooks.join(", ")} } from "${rel(config, "./runtime")}";`);
  for (const name of app.loaders) {
    const names =
      app.loaderArity[name] === 0 ? cap(name) : `${cap(name)}, ${cap(name)}Input`;
    e.line(`import type { ${names} } from "${rel(config, "./types")}";`);
  }
  for (const name of app.formActions) {
    e.line(`import type { ${cap(name)}Input } from "${rel(config, "./types")}";`);
  }
  e.line();

  app.spec.pages.forEach((page, index) => {
    const path: SpecPath = ["pages", page.route];
    const used = usedLoaders(page.sections);
    const usedActions = collect(page.sections, "actions");
    const routeParams = routeParamsOf(page.route);

    // Every route param feeds the loader query (§6.2), so a page with any loader needs a
    // local for each of them. A page with no loader needs one only for the params a prop
    // actually binds — under `noUnusedLocals`, declaring the rest would fail the build.
    const boundParams = new Set(collect(page.sections, "param"));
    const paramLocals =
      used.length > 0 ? routeParams : routeParams.filter((name) => boundParams.has(name));

    // Exported because pages.tsx builds the route map out of these, and annotated
    // because that is what keeps `import * as React` a used import under
    // `noUnusedLocals` while still putting React in scope for a host on classic JSX.
    e.line(
      `export function Page_${index}({ params }: { params: Record<string, string> }): React.ReactElement {`,
      path,
    );
    e.indent();
    // `params` is destructured out of the props object, so under `noUnusedLocals` it has
    // to be read. Narrowing a route param into a local already reads it; only a page that
    // narrows none needs the discard.
    if (paramLocals.length === 0) e.line("void params;");
    for (const name of [...paramLocals].sort()) {
      e.line(`const ${paramLocal(name)} = params[${JSON.stringify(name)}] ?? "";`);
    }
    if (pageNeedsFilters(page)) {
      const defaults = page.filters
        .map((f) => `${JSON.stringify(f.name)}: ${JSON.stringify(String(f.default ?? ""))}`)
        .join(", ");
      e.line(`const filters = useFilters({ ${defaults} });`);
    }
    // §6.2: "Loader inputs are supplied from route params and filter values." A route
    // param and a filter of the same name are the same input; the route param wins,
    // because it comes from the URL path rather than from a query string the user can
    // clear. Keys are sorted so the object is byte-identical across runs.
    const queryEntries = new Map<string, string>();
    for (const f of page.filters) queryEntries.set(f.name, `filters[${JSON.stringify(f.name)}]`);
    for (const name of routeParams) queryEntries.set(name, paramLocal(name));
    const query =
      queryEntries.size === 0
        ? "{}"
        : `{ ${[...queryEntries.keys()]
            .sort()
            .map((k) => `${JSON.stringify(k)}: ${queryEntries.get(k)!}`)
            .join(", ")} }`;
    for (const name of used) {
      // The second type argument is what makes the assembled query object a checked
      // input rather than an untyped bag: `useLoader<T, Input>` takes
      // `Record<string, string> & Input`, so a field the loader requires and neither a
      // param nor a filter supplies is a type error — reported at the spec binding that
      // named the loader, via the origin recorded here. A loader declared with no
      // parameters is exempt: it is called with no argument at all (see handlers.ts),
      // and its `Input` is `Record<string, never>`, which no filter value can satisfy.
      const typeArgs =
        app.loaderArity[name] === 0 ? `<${cap(name)}>` : `<${cap(name)}, ${cap(name)}Input>`;
      e.line(
        `const ${name} = useLoader${typeArgs}("${urlFor(config, "_data", name)}", ${query});`,
        app.loaderOrigins[name],
      );
    }
    const options = optionsByAction(page.sections);
    for (const name of usedActions) {
      e.line(
        `const ${name}Action = useAction("${urlFor(config, "_actions", name)}"${optsArg(options.get(name))});`,
      );
    }
    // One sort state per page (NOVA1011 rejects a second sortable section), hoisted like
    // every other hook. `sortState` rather than `sort` so it does not collide with a
    // filter or component named `sort` reading naturally in the same file.
    if (pageNeedsSort(page)) e.line("const sortState = useSort();");
    // One `useForm` per form, hoisted above the JSX like every other hook. The generic
    // is the action's own input type, which is what makes each field's `name` a checked
    // key of it — and makes the assembled initial-value object a completeness check on
    // the form: a required input key no field covers is a missing property here,
    // reported at this line, which maps back to the `- Form:` section.
    for (const { section, path: formPath } of collectForms(page.sections, [...path, "sections"])) {
      const action = section.submit!;
      const initial = (section.fields ?? [])
        .map((f) => `${JSON.stringify(f.name)}: ${JSON.stringify(f.initial)}`)
        .join(", ");
      e.line(
        `const ${action}Form = useForm<${cap(action)}Input>("${urlFor(config, "_actions", action)}", ${
          initial === "" ? "{}" : `{ ${initial} }`
        }${optsArg(optsOf(section))});`,
        formPath,
      );
    }
    if (used.length > 0) {
      const anyError = used.map((n) => `${n}.error`).join(" ?? ");
      const anyValueNull = used.map((n) => `${n}.value === null`).join(" || ");
      e.line(`const error = ${anyError};`);
      e.line(`if (error) return <${config.states.error}>{error}</${config.states.error}>;`);
      e.line(`if (${anyValueNull}) return <${config.states.loading} />;`);
    }
    e.line("return (");
    e.indent().line("<>");
    e.indent();
    page.sections.forEach((section, i) => {
      emitSection(section, [...path, "sections", i]);
    });
    e.dedent().line("</>").dedent();
    e.line(");");
    e.dedent();
    e.line("}");
    e.line();
  });

  return { name: "views.tsx", text: e.text(), map: e.map() };

  /** `a={x} b={y}`, sorted by prop name so emission is byte-deterministic. */
  function attrs(entries: Map<string, string>): string {
    return [...entries.keys()]
      .sort()
      .map((p) => `${p}={${entries.get(p)!}}`)
      .join(" ");
  }

  function emitSection(section: SectionSpec, path: SpecPath): void {
    const name = section.component.name;
    const entries = new Map<string, string>();
    for (const p of Object.keys(section.props)) entries.set(p, expr(section.props[p]!));
    if (section.submit !== undefined) {
      // The form shell's half of the contract: run the submission, and show that it is
      // running and whether it failed. `validate` has already rejected a spec that also
      // sets any of these itself (NOVA1001).
      const form = formLocal(section.submit);
      entries.set("busy", `${form}.busy`);
      entries.set("error", `${form}.error`);
      entries.set("onSubmit", `${form}.submit`);
    }
    if (section.sortable !== undefined) {
      entries.set("sort", "sortState.value");
      entries.set("onSort", "sortState.set");
    }
    const props = attrs(entries);
    const open = props === "" ? `<${name}` : `<${name} ${props}`;
    const fields = section.fields ?? [];
    if (fields.length === 0 && section.children.length === 0) {
      e.line(`${open} />`, path);
      return;
    }
    e.line(`${open}>`, path);
    e.indent();
    // Both nested paths carry the component's own YAML key, because that is where the
    // document actually holds them: `sections[0].Panel.children[1]`. Without it,
    // positions.at() finds no node and silently falls back to the parent section, so
    // every diagnostic inside a nested section reported against its container.
    const key = componentKey(section.component);
    fields.forEach((field, i) => {
      emitField(field, section.submit!, [...path, key, "fields", i]);
    });
    section.children.forEach((child, i) => emitSection(child, [...path, key, "children", i]));
    e.dedent();
    e.line(`</${name}>`, path);
  }

  /**
   * One field, bound to its key of the form's action input.
   *
   * `values[...]`, `set(...)` and `errors[...]` are all indexed by the same string
   * literal, and `useForm`'s generic is the action's declared input type — so a `name:`
   * the action does not accept is three type errors on this one line, all remapped to
   * this field's own line in the spec. Indexed rather than dotted access so a key that
   * is not a JavaScript identifier still emits valid, still-checked code.
   */
  function emitField(field: FieldSpec, action: string, path: SpecPath): void {
    const form = formLocal(action);
    const key = JSON.stringify(field.name);
    const entries = new Map<string, string>();
    for (const p of Object.keys(field.props)) entries.set(p, expr(field.props[p]!));
    entries.set("value", `${form}.values[${key}]`);
    // Unannotated on purpose: the parameter's type comes from the component's own
    // `onChange` prop, so a NumberField bound to a string key is a type error here
    // rather than a silent coercion.
    entries.set("onChange", `(value) => ${form}.set(${key}, value)`);
    entries.set("error", `${form}.errors[${key}]`);
    e.line(`<${field.component.name} ${attrs(entries)} />`, path);
  }
}

/** The page-local holding one form's state. One per action, per page. */
const formLocal = (action: string) => `${action}Form`;

/** Every form on a page, in document order, with the spec path of its section. */
function collectForms(
  sections: SectionSpec[],
  path: SpecPath,
): { section: SectionSpec; path: SpecPath }[] {
  const out: { section: SectionSpec; path: SpecPath }[] = [];
  sections.forEach((section, i) => {
    const at = [...path, i];
    if (section.submit !== undefined) out.push({ section, path: at });
    out.push(
      ...collectForms(section.children, [...at, componentKey(section.component), "children"]),
    );
  });
  return out;
}

/**
 * Which runtime hooks this app's generated pages will actually import.
 *
 * A host with `noUnusedLocals` fails the build on an unconditional import that a given
 * spec never calls — a spec with no filters, no bound action, or no data binding at all
 * is entirely ordinary, not a spec bug. A page can also *declare* filters without
 * anything reading them yet (see pageNeedsFilters), so "has filters" alone is not
 * sufficient.
 *
 * `emitRuntime` reads the same answer, so the hooks runtime.tsx defines and the hooks
 * pages.tsx imports agree by construction rather than by coincidence.
 */
export function hooksUsed(app: ResolvedApp): {
  useAction: boolean;
  useFilters: boolean;
  useForm: boolean;
  useLoader: boolean;
  useSort: boolean;
} {
  return {
    // "the app has actions" is not the same question: a form's action is submitted
    // through `useForm`, so a page whose only action is a form's binds no `useAction`
    // of its own and must not import one.
    useAction: app.spec.pages.some((p) => collect(p.sections, "actions").length > 0),
    useFilters: app.spec.pages.some(pageNeedsFilters),
    useForm: app.formActions.length > 0,
    useLoader: app.loaders.length > 0,
    useSort: app.spec.pages.some(pageNeedsSort),
  };
}

// A page's `filters` local is only worth declaring when something in that page's
// function body will actually read it: at least one loader (filters feed the loader's
// query object), or a component prop bound directly to `filters.xxx` (a filter value
// can be rendered or otherwise consumed with no loader involved at all — TabNav's
// `active` state driven straight from a filter, for example). "the page declares
// filters" alone is not enough — under `noUnusedLocals`, a page with filters that
// nothing reads (yet) must not declare the local.
function pageNeedsFilters(page: PageSpec): boolean {
  return page.filters.length > 0 && (usedLoaders(page.sections).length > 0 || collect(page.sections, "filter").length > 0);
}

/** Whether any section on this page declares sortable columns. */
function pageNeedsSort(page: PageSpec): boolean {
  const walk = (list: SectionSpec[]): boolean =>
    list.some((s) => s.sortable !== undefined || walk(s.children));
  return walk(page.sections);
}

function usedLoaders(sections: SectionSpec[]): string[] {
  return collect(sections, "data");
}

function collect(
  sections: SectionSpec[],
  kind: "data" | "actions" | "filter" | "param",
): string[] {
  const found = new Set<string>();
  const add = (props: Record<string, PropValue>) => {
    for (const value of Object.values(props)) {
      if (value.kind === "binding" && value.ref.kind === kind) found.add(value.ref.name);
    }
  };
  const walk = (list: SectionSpec[]) => {
    for (const s of list) {
      add(s.props);
      // A field's own props bind like any other: a select's options can come from a
      // loader, its label from a filter. Skipping them here would leave the loader
      // undiscovered and the emitted page referencing a local that was never declared.
      for (const field of s.fields ?? []) add(field.props);
      walk(s.children);
    }
  };
  walk(sections);
  return [...found].sort();
}
