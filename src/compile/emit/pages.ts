import {
  componentKey,
  type FieldSpec,
  type FilterSpec,
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

/**
 * A filter's starting value: a literal, or the result of calling the `compute#` function
 * its `default:` names. Stringified because a filter value lives in the query string and
 * is therefore a `string`; a compute whose return type is not one is a type error at the
 * `useFilters` call, remapped to the page's own `filters:` block.
 *
 * The call is evaluated during render, on the server as well as in the browser — see the
 * hydration note in the README. Nova never learns what a month is.
 */
function filterDefault(filter: FilterSpec): string {
  const value = filter.default;
  if (value === undefined) return '""';
  return value.kind === "literal"
    ? JSON.stringify(String(value.value ?? ""))
    : `compute.${value.ref.name}()`;
}

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

  // There is no `titles` map any more. `title:` used to be emitted as one because nova
  // had nowhere to render it — and no consuming host ever mounted it, so it was dead
  // weight in every app. `config.shell` gives the title a real destination, inside the
  // page, so the map is gone rather than kept as a second, unused way to reach it.
  return { name: "pages.tsx", text: e.text(), map: e.map() };
}

/** The page components themselves: the `"use client"` half of the emitted pair. */
export function emitViews(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  /** Loaders whose failure this page has already stated once. Reset per page; see gate. */
  let announced = new Set<string>();
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
  if (app.computes.length > 0) e.line(`import * as compute from "${appRel(app, config, "compute")}";`);
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
  // An action bound to an ordinary prop also needs its own *type* — `useAction`'s second
  // argument is `Awaited<ReturnType<…>>`, which is what carries the action's answer out
  // to the component. A form's action needs only its input, and importing a type it never
  // names would fail a host with `noUnusedLocals`.
  const propActions = new Set(app.spec.pages.flatMap((p) => collect(p.sections, "actions")));
  for (const name of app.actions) {
    const names = propActions.has(name) ? `${cap(name)}, ${cap(name)}Input` : `${cap(name)}Input`;
    e.line(`import type { ${names} } from "${rel(config, "./types")}";`);
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
        .map((f) => `${JSON.stringify(f.name)}: ${filterDefault(f)}`)
        .join(", ");
      // Mapped to the page's own `filters:` block, so a computed default whose type is
      // not the `string` a filter holds is reported there rather than at a generated line.
      e.line(`const filters = useFilters({ ${defaults} });`, [...path, "filters"]);
    }
    // One sort state per page (NOVA1011 rejects a second sortable section), hoisted
    // above the loaders because a loader that declares `sort`/`dir` reads it — a const
    // referenced before its declaration is a ReferenceError, not a lint nit.
    // `sortState` rather than `sort` so it does not collide with a filter or component
    // named `sort` reading naturally in the same file.
    if (pageNeedsSort(page)) e.line("const sortState = useSort();");

    // §6.2: "Loader inputs are supplied from route params and filter values." A route
    // param and a filter of the same name are the same input; the route param wins,
    // because it comes from the URL path rather than from a query string the user can
    // clear. Keys are sorted so the object is byte-identical across runs.
    const available = new Map<string, string>();
    for (const f of page.filters) available.set(f.name, `filters[${JSON.stringify(f.name)}]`);
    for (const name of routeParams) available.set(name, paramLocal(name));

    // Sort state is offered to a loader on exactly the terms a filter is, and reaches
    // one only where the loader's own input type names `sort`/`dir`. That is the opt-in:
    // a table holding all its rows sorts them in the browser and its loader says
    // nothing, while a paginated one — where sorting the 25 rows on screen is a wrong
    // answer about 6,480 — declares the two keys and is re-requested when they change.
    // Making it automatic instead would re-request every table on every header click and
    // hand the keys to loaders that have no idea what to do with them; making it new
    // spec vocabulary would put the fact in the YAML rather than in the signature of the
    // function that has to honour it, where TypeScript can no longer check it.
    // NOVA1014 rejects a filter named `sort` or `dir` on such a page, so nothing here
    // can be overwritten by one.
    const sortValues = new Map<string, string>(
      pageNeedsSort(page)
        ? [
            ["sort", '(sortState.value?.column ?? "")'],
            ["dir", '(sortState.value?.direction ?? "asc")'],
          ]
        : [],
    );

    /**
     * The input object one loader is called with: the keys *it* declares, and only
     * those.
     *
     * Every loader used to be handed the page's whole filter set and route params, so a
     * loader declaring nothing was re-requested on every filter change and a loader
     * declaring one key was re-requested when an unrelated filter moved. On a reporting
     * page with three filters and seven loaders that is seven requests per click, three
     * of them for constant option lists. Where the parameter type has no closed set of
     * keys to read (an index signature, a primitive, a generic) there is nothing to
     * narrow by and the whole set is passed, exactly as before.
     *
     * A key the loader declares and the page cannot supply is still absent from the
     * object, so it stays the NOVA3001 it always was, at the binding that named it.
     */
    function queryFor(loader: string): string {
      // A zero-parameter loader is called with no argument at all (see handlers.ts), so
      // the object exists only to satisfy `useLoader`'s signature. Anything in it is a
      // dependency the loader never asked for and a refetch nobody wanted.
      if (app.loaderArity[loader] === 0) return "{}";
      const declared = app.loaderInputKeys[loader] ?? null;
      const entries =
        declared === null
          ? [...available.keys()]
          : declared.filter((k) => available.has(k) || sortValues.has(k));
      if (entries.length === 0) return "{}";
      return `{ ${entries
        .sort()
        .map((k) => `${JSON.stringify(k)}: ${available.get(k) ?? sortValues.get(k)!}`)
        .join(", ")} }`;
    }

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
        `const ${name} = useLoader${typeArgs}("${urlFor(config, "_data", name)}", ${queryFor(name)});`,
        app.loaderOrigins[name],
      );
    }
    const options = optionsByAction(page.sections);
    // Both type arguments are what make an action bound to an ordinary prop checked.
    // `run` was declared `(input: unknown) => Promise<boolean>`, and an `unknown`
    // parameter is assignable to every callback shape there is — so `onDelete={
    // deleteTripAction.run}` type-checked against `(row: Trip) => void` whatever the
    // action actually accepted. With the action's own input type it is the ordinary
    // contravariant check, reported at the spec line that bound it.
    //
    // The second is the action's own result. A boolean `run` could say only that a
    // submission succeeded or did not, so an upstream that accepted the claim *and*
    // reported something recoverable was presented to the reader as a failure — with the
    // claim persisted and the list un-refreshed behind it. `Awaited<ReturnType<…>>`
    // rather than an emitted `XxxResult` alias: one type per action in every app's
    // types.ts, unread by the forms half, is dead weight in the common case.
    for (const name of usedActions) {
      e.line(
        `const ${name}Action = useAction<${cap(name)}Input, Awaited<ReturnType<${cap(name)}>>>("${urlFor(config, "_actions", name)}"${optsArg(options.get(name))});`,
        app.actionOrigins[name],
      );
    }
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
    // The shell wraps the page, always: a title and the spacing around it are the page,
    // not decoration on its happy path, and there is no longer any early return that
    // could skip it. Without a configured shell this is the bare fragment every page
    // emitted before.
    //
    // What used to stand here — `const error = a.error ?? b.error; if (error) return
    // <ErrorNotice>` and a matching null gate — made every loader on a page a
    // prerequisite for every part of it. A differential audit of a converted production
    // app fault-injected one of five loaders into a 500 and lost the navigation, the
    // header, the stats, every section and both forms; the hand-written original it
    // replaced lost one panel. The states are rendered per section now (see emitSection),
    // which is also why a page's first paint is its chrome rather than one spinner.
    const open =
      config.shell === undefined
        ? "<>"
        : `<${config.shell}${page.title === undefined ? "" : ` title={${JSON.stringify(page.title)}}`}>`;
    const close = config.shell === undefined ? "</>" : `</${config.shell}>`;
    e.line("return (");
    e.indent().line(open, path);
    e.indent();
    // One page, one notice per failed loader — see `gate`. Reset here because the set is
    // about a page's own screen, and filled in emission order, which is document order.
    announced = new Set<string>();
    page.sections.forEach((section, i) => {
      emitSection(section, [...path, "sections", i]);
    });
    e.dedent().line(close).dedent();
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

  /**
   * The conditional a section is rendered behind: its error state where its own data
   * failed, its loading state where that data has not arrived, and the section itself
   * otherwise. `""`/`""` for a section that binds no loader — chrome renders regardless.
   *
   * Written as a chain of `x.error !== null ? …` rather than one `a.error ?? b.error`
   * test so that each branch *narrows*: `x.error` is a `string` inside the branch that
   * renders it, and every `x.value` is non-null in the final branch, exactly as the
   * page-level check narrowed them before. The narrowing is what keeps a component prop
   * from receiving `null` and a wrong-typed binding a compile error at the spec line;
   * nothing here casts.
   *
   * **One loader's failure is stated once.** The section is the unit that *degrades*; it
   * is not the unit a failure is reported in. A detail page hangs five sections off one
   * loader and printed the same sentence four times; a report page printed six. The first
   * section (in document order) that binds a loader renders its notice, and every later
   * section binding the same failed loader renders nothing at all — it has no data, and
   * the reason has already been given above it. The loading state is deliberately *not*
   * deduplicated: a spinner marks where a section will be, and four of them is what a
   * page still arriving looks like, whereas four copies of one sentence is one fact
   * asserted four times.
   */
  function gate(section: SectionSpec): { open: string; close: string } {
    const loaders = ownLoaders(section);
    if (loaders.length === 0) return { open: "", close: "" };
    const failed = loaders
      .map((n) => {
        const notice = announced.has(n)
          ? "null"
          : `<${config.states.error}>{${n}.error}</${config.states.error}>`;
        announced.add(n);
        return `${n}.error !== null ? ${notice} : `;
      })
      .join("");
    const waiting = loaders.map((n) => `${n}.value === null`).join(" || ");
    return { open: `{${failed}${waiting} ? <${config.states.loading} /> : `, close: "}" };
  }

  function emitSection(section: SectionSpec, path: SpecPath): void {
    const name = section.component.name;
    const { open: before, close: after } = gate(section);
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
      e.line(`${before}${open} />${after}`, path);
      return;
    }
    e.line(`${before}${open}>`, path);
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
    e.line(`</${name}>${after}`, path);
  }

  /**
   * One field, bound to its key of the form's action input.
   *
   * `values[...]`, `set(...)` and `errors[...]` are all indexed by the same string
   * literal, and `useForm`'s generic is the action's declared input type — so a `name:`
   * the action does not accept is three type errors on this one line, all remapped to
   * this field's own line in the spec. Indexed rather than dotted access so a key that
   * is not a JavaScript identifier still emits valid, still-checked code.
   *
   * A **generic** field component is written with its type argument rather than left to
   * inference. A type parameter no supplied prop mentions is not inferred from anything;
   * it resolves to something that makes every constraint derived from it vacuous, and
   * the check the generic exists for disappears without a word. Nova knows the one type
   * a field is about — the type of the input key it edits — so it writes it.
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
    const typeArgs =
      (app.componentTypeParams[componentKey(field.component)]?.total ?? 0) === 0
        ? ""
        : `<${cap(action)}Input[${key}]>`;
    e.line(`<${field.component.name}${typeArgs} ${attrs(entries)} />`, path);
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
//
// Exported because `resolve.ts` asks the same question about a filter's `compute#`
// default: no local means no call, and no call means the compute module must not be
// imported either.
export function pageNeedsFilters(page: PageSpec): boolean {
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

/**
 * The loaders one section reads *itself* — its own props and its own fields', not its
 * children's. A child section carries its own gate, so a container that binds nothing
 * (a panel, a toolbar) keeps rendering when a component inside it has no data: the unit
 * that degrades is the section that actually needed the loader, which is as fine-grained
 * as the spec can describe. Fields are the section's, not their own units, because the
 * conditional wraps the whole element and the form shell has to stay with its inputs.
 */
function ownLoaders(section: SectionSpec): string[] {
  const found = new Set<string>();
  for (const props of [section.props, ...(section.fields ?? []).map((f) => f.props)]) {
    for (const value of Object.values(props)) {
      if (value.kind === "binding" && value.ref.kind === "data") found.add(value.ref.name);
    }
  }
  return [...found].sort();
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
