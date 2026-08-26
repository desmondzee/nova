import { readdirSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import {
  diagnostic,
  suggest,
  type Diagnostic,
  type PositionMap,
  type SpecPath,
} from "../schema/diagnostic.js";
import { componentKey, type AppSpec, type PageSpec, type PropValue, type SectionSpec } from "../schema/types.js";
import { isComponentName, type Catalog } from "./catalog.js";
import type { NovaConfig } from "./config.js";
// A spec-shape predicate, not an emitter: `pageNeedsFilters` answers whether a generated
// page will declare a `filters` local at all. It lives beside the code that emits one so
// the two cannot drift; nothing at runtime flows the other way (emit/pages.ts's import of
// this module is type-only), so there is no cycle.
import { pageNeedsFilters } from "./emit/pages.js";
import {
  createProgram,
  moduleExports,
  resolveModule,
  type ExportInfo,
  type ProgramSession,
} from "./program.js";

function collectLocalModules(sections: SectionSpec[], into: Set<string>): void {
  for (const section of sections) {
    if (section.component.kind === "local") into.add(section.component.module);
    for (const field of section.fields ?? []) {
      if (field.component.kind === "local") into.add(field.component.module);
    }
    collectLocalModules(section.children, into);
  }
}

export type ModuleBinding = { name: string; module: string };

export type ResolvedApp = {
  spec: AppSpec;
  /**
   * The app directory, resolved to an absolute path.
   *
   * Every emitted specifier back to the app's own modules is computed from it and the
   * resolved `outDir`. It used to be computed from `process.cwd()` instead, which
   * coincides with the app directory only for an `outDir` nested inside the app and a
   * build run from the app's own parent — so an absolute or escaping `outDir` emitted
   * imports that could not resolve.
   */
  appDir: string;
  components: ModuleBinding[];
  loaders: string[];
  actions: string[];
  computes: string[];
  /** Parameter count of each loader's underlying data.ts export. A loader with no
   * declared parameters (0) is called with no argument, and gets a plain `Input` type
   * instead of indexing into an empty `Parameters<...>` tuple. */
  loaderArity: Record<string, number>;
  /**
   * The keys each loader's declared input type actually names, or `null` where its
   * parameter type has no closed set of them (an index signature, a primitive, a
   * generic). The emitter builds that loader's query object from these, so a loader is
   * re-requested only when something it declared a dependency on changed.
   */
  loaderInputKeys: Record<string, string[] | null>;
  /** Actions reached through a form's `submit:`, in sorted order. Only these need an
   * `${Cap}Input` type emitted, since only a form indexes into the action's input. */
  formActions: string[];
  /**
   * Actions bound to an ordinary component prop, in sorted order.
   *
   * The one thing that names an action's own `${Cap}` type is `useAction`'s
   * `Awaited<ReturnType<…>>`, and only a prop binding is hoisted into a `useAction` — a
   * form reaches its action through `useForm<${Cap}Input>` and never names the other
   * half. Emitting `${Cap}` for every action therefore put a line no emitted file
   * imported into every app with a form.
   */
  propActions: string[];
  /** Parameter count of each action's underlying actions.ts export, for the same
   * empty-tuple reason `loaderArity` exists. */
  actionArity: Record<string, number>;
  /**
   * Type parameters of each component the spec binds, keyed by the reference as written
   * (`ChoiceField`, `./views/fields#DecimalField`).
   *
   * Only a *field* is emitted with a type argument, and only because nova knows what it
   * should be — the type of the action-input key the field edits. A generic component
   * invoked with none resolves its parameter by inference, and a parameter no supplied
   * prop mentions falls back to something that makes every constraint derived from it
   * vacuous, so the check the generic exists for silently disappears.
   */
  componentTypeParams: Record<string, { total: number; required: number }>;
  /** First spec location that referenced each loader/action, used to give contract
   * diagnostics (arity, non-async) a real position instead of the document root. */
  loaderOrigins: Record<string, SpecPath>;
  actionOrigins: Record<string, SpecPath>;
};

type Ctx = {
  config: NovaConfig;
  appDir: string;
  specFile: string;
  catalog: Catalog;
  positions: PositionMap;
  session?: ProgramSession;
};

const sorted = (s: Set<string>) => [...s].sort();

// One base name's exports, resolved against a `ts.Program` that already covers
// every candidate file. `.ts` is preferred over `.tsx` when both exist. A base
// with no matching source file yields an empty set.
const EXPORT_BASES = ["data", "actions", "compute"] as const;
const EXPORT_EXTS = [".ts", ".tsx"] as const;

/**
 * Resolves the exports of `data`, `actions` and `compute` in one pass.
 *
 * The naive approach — one `createProgram` call per base name per extension —
 * creates up to six `ts.Program`s per app, and each one re-globs the entire
 * tsconfig `include`. On a host tsconfig spanning a whole repository, building
 * every app multiplies that into hundreds of full-project parses. Instead we
 * build every candidate path up front and create a single program that covers
 * all of them, then read each base's exports from that same program.
 */
function exportsOf(
  appDir: string,
  tsconfigPath: string,
  session: ProgramSession | undefined,
): { byBase: Map<string, Map<string, ExportInfo>>; miscased: string[] } {
  const roots = EXPORT_BASES.flatMap((base) =>
    EXPORT_EXTS.map((ext) => resolve(appDir, base + ext)),
  );
  const handle = createProgram({ tsconfigPath, roots, session });
  const onDisk = entriesOf(appDir);
  const miscased: string[] = [];

  const result = new Map<string, Map<string, ExportInfo>>();
  for (const base of EXPORT_BASES) {
    let exportsByName = new Map<string, ExportInfo>();
    if (handle) {
      for (const ext of EXPORT_EXTS) {
        const file = resolve(appDir, base + ext);
        if (handle.program.getSourceFile(file)) {
          // `getSourceFile` answered yes, which on macOS and Windows it also does for a
          // file whose real name differs only in case. The directory listing is the only
          // thing that knows: see `entriesOf`.
          const real = onDisk.find((e) => e.toLowerCase() === base + ext);
          if (real !== undefined && real !== base + ext) miscased.push(real);
          exportsByName = new Map(
            // `signatures` only for data.ts: a loader's declared input keys are what the
            // emitter builds its query object from. actions.ts and compute.ts have no
            // such use, and reading it would resolve types for nothing.
            moduleExports(handle.program, file, { signatures: base === "data" }).map((e) => [
              e.name,
              e,
            ]),
          );
          break;
        }
      }
    }
    result.set(base, exportsByName);
  }
  return { byBase: result, miscased: miscased.sort() };
}

/**
 * The app folder's entries as the filesystem actually spells them, or `[]` where it
 * cannot be listed (which is not this function's problem to report — a missing app dir
 * has already been answered as `NOVA1006`).
 *
 * `ts.Program.getSourceFile` canonicalises case on macOS and Windows, so `Data.ts`
 * satisfied the lookup for `data.ts` and nova emitted `from "../data"` — a specifier
 * that does not resolve on Linux. The result was a build that was clean locally, `ok:
 * true`, zero diagnostics, and a CI failure inside generated code the author did not
 * write. Nothing inside TypeScript can see the difference; only the directory listing
 * can.
 */
function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function resolveApp(
  spec: AppSpec,
  ctx: Ctx,
): { resolved: ResolvedApp | null; diagnostics: Diagnostic[] } {
  const out: Diagnostic[] = [];
  const components = new Map<string, ModuleBinding>();
  const loaders = new Set<string>();
  const actions = new Set<string>();
  const computes = new Set<string>();
  const loaderArity: Record<string, number> = {};
  const loaderInputKeys: Record<string, string[] | null> = {};
  const formActions = new Set<string>();
  const propActions = new Set<string>();
  const actionArity: Record<string, number> = {};
  const componentTypeParams: Record<string, { total: number; required: number }> = {};
  const loaderOrigins: Record<string, SpecPath> = {};
  const actionOrigins: Record<string, SpecPath> = {};
  const computeOrigins: Record<string, SpecPath> = {};

  const { byBase: exportsByBase, miscased } = exportsOf(
    ctx.appDir,
    ctx.config.tsconfigPath,
    ctx.session,
  );
  const dataExports = exportsByBase.get("data") ?? new Map<string, ExportInfo>();
  const actionExports = exportsByBase.get("actions") ?? new Map<string, ExportInfo>();
  const computeExports = exportsByBase.get("compute") ?? new Map<string, ExportInfo>();

  // Diagnosed, not accommodated. Nova could emit `from "../Data"` and be correct
  // everywhere, but the three module names are the spec's own vocabulary — the README
  // documents `data.ts`, `actions.ts` and `compute.ts` by name, and `data#orders` is
  // written against that name — so a `Data.ts` that only works because the developer's
  // filesystem folds case is a spelling nova should not silently adopt into an app that
  // two other people will check out. Renaming the file is one command and leaves one
  // spelling on every machine.
  for (const real of miscased) {
    out.push(
      diagnostic(
        "NOVA2015",
        `'${real}' differs in case from '${real.toLowerCase()}'`,
        { file: resolve(ctx.appDir, real), line: 1, col: 1 },
        {
          hint: `rename it to '${real.toLowerCase()}' — this filesystem folds case, a Linux one does not`,
        },
      ),
    );
  }

  // Resolve every distinct local component module referenced by the spec once,
  // and cover them all with a single additional program (never one program per
  // reference, and never one per usage of the same module).
  const localModuleSpecifiers = new Set<string>();
  for (const page of spec.pages) collectLocalModules(page.sections, localModuleSpecifiers);

  const localModuleFiles = new Map<string, string | null>();
  for (const specifier of localModuleSpecifiers) {
    localModuleFiles.set(
      specifier,
      resolveModule(specifier, ctx.specFile, ctx.config.tsconfigPath, ctx.session),
    );
  }
  const localRoots = [...localModuleFiles.values()].filter((f): f is string => f !== null);
  const localHandle =
    localRoots.length > 0
      ? createProgram({
          tsconfigPath: ctx.config.tsconfigPath,
          roots: localRoots,
          session: ctx.session,
        })
      : null;

  // catalog.ts and the local-component resolution above both resolve a component's
  // module specifier relative to the spec file (ctx.appDir). But emitPages copies
  // `ModuleBinding.module` verbatim into a file that ends up written to
  // `ctx.appDir/ctx.config.outDir` — one or more directories deeper. A relative
  // specifier that was correct from the spec file's directory is not necessarily
  // correct from there, so any relative specifier is rewritten here, once, to be
  // correct as seen from outDir, using the already-resolved absolute file (either
  // `CatalogEntry.file` or the `resolveModule` result for a local ref). Bare
  // specifiers (bare package imports, e.g. "@scope/ui") are left untouched — they
  // resolve independently of file depth.
  function specifierFromOutDir(specifier: string, resolvedFile: string): string {
    if (!specifier.startsWith(".")) return specifier;
    const outDir = resolve(ctx.appDir, ctx.config.outDir);
    const noExt = resolvedFile.slice(0, resolvedFile.length - extname(resolvedFile).length);
    const rel = relative(outDir, noExt).split(sep).join("/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  function addComponent(name: string, module: string, at: { file: string; line: number; col: number }): void {
    const existing = components.get(name);
    if (existing) {
      if (existing.module !== module) {
        out.push(
          diagnostic(
            "NOVA2009",
            `component '${name}' is bound to both '${existing.module}' and '${module}' — rename one`,
            at,
          ),
        );
      }
      return;
    }
    components.set(name, { name, module });
  }

  for (const page of spec.pages) {
    const routeParams = new Set(
      page.route
        .split("/")
        .filter((s) => s.startsWith(":"))
        .map((s) => s.slice(1)),
    );
    const filterNames = new Set(page.filters.map((f) => f.name));
    walk(page.sections, page, routeParams, filterNames, ["pages", page.route, "sections"]);

    // A filter's `default:` may be a `compute#` binding, which the generated page calls
    // for the starting value. The name is reported whether or not the page ends up
    // declaring a `filters` local, but only *recorded* when it does: `computes` decides
    // whether views.tsx imports the compute module at all, and an import nothing calls
    // fails a host with `noUnusedLocals`. pageNeedsFilters is the same predicate the
    // emitter uses to decide that, so the two agree by construction rather than by
    // coincidence — the reason hooksUsed is shared the same way.
    for (const filter of page.filters) {
      const value = filter.default;
      if (value?.kind !== "binding") continue;
      const at: SpecPath = ["pages", page.route, "filters", filter.name, "default"];
      const name = value.ref.name;
      if (!computeExports.has(name)) {
        report("NOVA2004", `compute.ts has no export '${name}'`, ctx.positions.at(at), computeExports, name);
      } else if (pageNeedsFilters(page)) {
        computes.add(name);
        computeOrigins[name] ??= at;
      }
    }
  }

  // One name may not mean two things. `types.ts` derives `export type ${Cap}` from the
  // namespace a name lives in, and `__contract.ts` binds `const _${name}`, so a loader
  // and an action both called `sync` emit each of those twice. TypeScript then reports
  // "Cannot redeclare block-scoped variable '_sync'" against the author's spec line — a
  // nova bug wearing a spec error's clothes. Caught here instead, at resolve time,
  // before anything is emitted. NOVA2009 is the existing code for exactly this shape of
  // problem ("one name is bound to two different things — rename one"); it previously
  // only covered components.
  const NAMESPACES = [
    ["a data loader", loaders, loaderOrigins],
    ["an action", actions, actionOrigins],
    ["a compute function", computes, computeOrigins],
  ] as const;
  for (let i = 0; i < NAMESPACES.length; i++) {
    for (let j = i + 1; j < NAMESPACES.length; j++) {
      const [firstLabel, firstNames, firstOrigins] = NAMESPACES[i]!;
      const [secondLabel, secondNames, secondOrigins] = NAMESPACES[j]!;
      for (const name of sorted(firstNames)) {
        if (!secondNames.has(name)) continue;
        out.push(
          diagnostic(
            "NOVA2009",
            `'${name}' is bound as both ${firstLabel} and ${secondLabel} — rename one`,
            ctx.positions.at(firstOrigins[name] ?? secondOrigins[name] ?? []),
          ),
        );
      }
    }
  }

  // A bad `states` config should fail loudly regardless of whether a given spec ends up
  // rendering each state, so every name given is validated against the catalog
  // unconditionally. But only pull a state component into the emitted import list where a
  // generated page actually renders it: loading/error appear only on a page that binds at
  // least one loader (see emitViews), and no generated page renders an empty state at all
  // — importing it unconditionally is exactly what produces an unused-import error on a
  // host with `noUnusedLocals`. `states.empty` is optional for that reason; a host that
  // names one still gets it checked, and nothing else.
  const stateNames = {
    loading: ctx.config.states.loading,
    error: ctx.config.states.error,
    empty: ctx.config.states.empty,
    // Not a state, but resolved on exactly the same terms: a catalog name from config
    // that nova renders itself rather than forwarding a spec's props to.
    shell: ctx.config.shell,
  };
  const stateEntries = new Map<keyof typeof stateNames, ReturnType<Catalog["get"]>>();
  for (const [key, name] of Object.entries(stateNames) as [
    keyof typeof stateNames,
    string | undefined,
  ][]) {
    if (name === undefined) continue;
    const entry = ctx.catalog.get(name);
    stateEntries.set(key, entry);
    if (!entry) {
      out.push(
        diagnostic(
          "NOVA2001",
          `configured ${key} component '${name}' is not in any catalog`,
          ctx.positions.at([]),
          { hint: `available: ${ctx.catalog.names().join(", ")}` },
        ),
      );
    }
  }
  const named = (key: keyof typeof stateNames): void => {
    const entry = stateEntries.get(key);
    const name = stateNames[key];
    if (!entry || name === undefined) return;
    addComponent(name, specifierFromOutDir(entry.module, entry.file), ctx.positions.at([]));
  };
  if (loaders.size > 0) for (const key of ["loading", "error"] as const) named(key);
  // Every page is wrapped in the shell, so one page is enough to need it — and a spec
  // with no pages at all emits no JSX, where importing it would be an unused import.
  if (spec.pages.length > 0) named("shell");

  const fatal = out.some((d) => d.severity === "error");
  return {
    resolved: fatal
      ? null
      : {
          spec,
          appDir: resolve(ctx.appDir),
          components: [...components.values()].sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          ),
          loaders: sorted(loaders),
          actions: sorted(actions),
          computes: sorted(computes),
          loaderArity,
          loaderInputKeys,
          formActions: sorted(formActions),
          propActions: sorted(propActions),
          actionArity,
          componentTypeParams,
          loaderOrigins,
          actionOrigins,
        },
    diagnostics: out,
  };

  function walk(
    sections: SectionSpec[],
    page: PageSpec,
    routeParams: Set<string>,
    filterNames: Set<string>,
    path: (string | number)[],
  ): void {
    sections.forEach((section, i) => {
      const at = [...path, i];
      resolveComponent(section.component, at);

      // A form's `submit:` reaches actions.ts exactly as a prop binding does — the POST
      // handler, the contract binding and the emitted `${Cap}Input` type all come from
      // here — but it also records the arity, because `useForm` indexes into the
      // action's parameter tuple and a zero-parameter action has no element there.
      if (section.submit !== undefined) {
        const name = section.submit;
        const submitAt = ctx.positions.at([...at, componentKey(section.component), "submit"]);
        if (!actionExports.has(name)) {
          report("NOVA2003", `actions.ts has no export '${name}'`, submitAt, actionExports, name);
        } else {
          actions.add(name);
          formActions.add(name);
          actionArity[name] ??= actionExports.get(name)!.paramCount;
          if (actionOrigins[name] === undefined) {
            actionOrigins[name] = [...at, componentKey(section.component), "submit"];
          }
        }
      }

      (section.fields ?? []).forEach((field, f) => {
        const fieldAt = [...at, componentKey(section.component), "fields", f];
        resolveComponent(field.component, fieldAt);
        // A field is emitted with one explicit type argument — the type of the input key
        // it edits — so that a generic field component keeps the check its type parameter
        // exists for. A component wanting two type arguments has one nova cannot supply,
        // and an unsupplied parameter is an unchecked one, so it is reported rather than
        // emitted without.
        const tp = componentTypeParams[componentKey(field.component)];
        if (tp !== undefined && tp.required > 1) {
          out.push(
            diagnostic(
              "NOVA2012",
              `field component '${field.component.name}' needs ${tp.required} type arguments; nova supplies one`,
              ctx.positions.at(fieldAt),
              {
                hint: "a generic field component is generic in the value it carries — give the other parameters defaults, or wrap it in a non-generic component",
              },
            ),
          );
        }
        resolveBindings(field.props, fieldAt, page, routeParams, filterNames);
      });

      resolveBindings(section.props, at, page, routeParams, filterNames);

      walk(section.children, page, routeParams, filterNames, [
        ...at,
        componentKey(section.component),
        "children",
      ]);
    });
  }

  function resolveComponent(component: SectionSpec["component"], at: SpecPath): void {
    if (component.kind === "catalog") {
      const name = component.name;
      const entry = ctx.catalog.get(name);
      if (!entry) {
        const s = suggest(name, ctx.catalog.names());
        out.push(
          diagnostic("NOVA2001", `unknown component '${name}'`, ctx.positions.at(at), {
            hint:
              s === undefined
                ? `available: ${ctx.catalog.names().join(", ")}`
                : `did you mean '${s}'?`,
          }),
        );
      } else {
        componentTypeParams[name] = entry.typeParams;
        addComponent(name, specifierFromOutDir(entry.module, entry.file), ctx.positions.at(at));
      }
      return;
    }
    const { module, name } = component;
    const resolvedFile = localModuleFiles.get(module) ?? null;
    if (resolvedFile === null) {
      out.push(
        diagnostic(
          "NOVA2007",
          `local component module '${module}' cannot be resolved`,
          ctx.positions.at(at),
        ),
      );
      return;
    }
    const qualifying = (localHandle ? moduleExports(localHandle.program, resolvedFile) : []).filter(
      (e) => e.callable && isComponentName(e.name),
    );
    const match = qualifying.find((e) => e.name === name);
    if (match === undefined) {
      const s = suggest(name, qualifying.map((e) => e.name));
      out.push(
        diagnostic(
          "NOVA2008",
          `module '${module}' has no component export '${name}'`,
          ctx.positions.at(at),
          s === undefined ? {} : { hint: `did you mean '${s}'?` },
        ),
      );
      return;
    }
    componentTypeParams[componentKey(component)] = match.typeParams;
    addComponent(name, specifierFromOutDir(module, resolvedFile), ctx.positions.at(at));
  }

  function resolveBindings(
    props: Record<string, PropValue>,
    at: SpecPath,
    page: PageSpec,
    routeParams: Set<string>,
    filterNames: Set<string>,
  ): void {
    for (const propName of Object.keys(props).sort()) {
      const value = props[propName]!;
      if (value.kind !== "binding") continue;
      const ref = value.ref;
      const propAt = ctx.positions.at([...at, propName]);
      if (ref.kind === "data") {
        if (!dataExports.has(ref.name)) {
          report("NOVA2002", `data.ts has no export '${ref.name}'`, propAt, dataExports, ref.name);
        } else {
          loaders.add(ref.name);
          if (loaderArity[ref.name] === undefined) {
            const info = dataExports.get(ref.name)!;
            loaderArity[ref.name] = info.paramCount;
            loaderInputKeys[ref.name] = info.paramKeys;
            // Once per loader, not once per binding: the signature is the same however
            // many sections read it. Reported at the loader's own declaration, because
            // that is the line to edit — the spec never mentions the input's type.
            for (const key of info.paramKeysNeverString) {
              out.push(
                diagnostic(
                  "NOVA2017",
                  `loader '${ref.name}' declares input key '${key}' as a type a string can never be`,
                  { file: info.file, line: info.line, col: info.col },
                  {
                    hint: "a loader is called with the query string, so every input value is a string — declare it `string` and parse inside the loader",
                    related: [{ ...propAt, message: `bound here as '${propName}'` }],
                  },
                ),
              );
            }
          }
          if (loaderOrigins[ref.name] === undefined) loaderOrigins[ref.name] = [...at, propName];
        }
      } else if (ref.kind === "actions") {
        if (!actionExports.has(ref.name)) {
          report("NOVA2003", `actions.ts has no export '${ref.name}'`, propAt, actionExports, ref.name);
        } else {
          actions.add(ref.name);
          propActions.add(ref.name);
          // Recorded for every action, not only a form's: `useAction<XInput>` is what
          // makes a prop-bound action's payload a checked value, and a zero-parameter
          // action has no element in its `Parameters<...>` tuple to name.
          actionArity[ref.name] ??= actionExports.get(ref.name)!.paramCount;
          if (actionOrigins[ref.name] === undefined) actionOrigins[ref.name] = [...at, propName];
        }
      } else if (ref.kind === "compute") {
        if (!computeExports.has(ref.name)) {
          report("NOVA2004", `compute.ts has no export '${ref.name}'`, propAt, computeExports, ref.name);
        } else {
          computes.add(ref.name);
          if (computeOrigins[ref.name] === undefined) computeOrigins[ref.name] = [...at, propName];
        }
      } else if (ref.kind === "param") {
        if (!routeParams.has(ref.name)) {
          out.push(
            diagnostic("NOVA2005", `route '${page.route}' has no parameter ':${ref.name}'`, propAt),
          );
        }
      } else if (!filterNames.has(ref.name)) {
        out.push(
          diagnostic("NOVA2006", `page '${page.route}' declares no filter '${ref.name}'`, propAt),
        );
      }
    }
  }

  function report(
    code: string,
    message: string,
    at: { file: string; line: number; col: number },
    available: Map<string, ExportInfo>,
    name: string,
  ): void {
    const s = suggest(name, [...available.keys()]);
    out.push(diagnostic(code, message, at, s === undefined ? {} : { hint: `did you mean '${s}'?` }));
  }
}
