import { extname, join, relative, sep } from "node:path";
import { diagnostic, suggest, type Diagnostic, type SpecPath } from "../schema/diagnostic.js";
import { componentKey, type AppSpec, type PageSpec, type PropValue, type SectionSpec } from "../schema/types.js";
import { isComponentName, type Catalog } from "./catalog.js";
import type { NovaConfig } from "./config.js";
import type { PositionMap } from "./load.js";
import {
  createProgram,
  moduleExports,
  resolveModule,
  type ExportInfo,
  type ProgramSession,
} from "./program.js";

export type { SpecPath };

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
  components: ModuleBinding[];
  loaders: string[];
  actions: string[];
  computes: string[];
  /** Parameter count of each loader's underlying data.ts export. A loader with no
   * declared parameters (0) is called with no argument, and gets a plain `Input` type
   * instead of indexing into an empty `Parameters<...>` tuple. */
  loaderArity: Record<string, number>;
  /** Actions reached through a form's `submit:`, in sorted order. Only these need an
   * `${Cap}Input` type emitted, since only a form indexes into the action's input. */
  formActions: string[];
  /** Parameter count of each form action's underlying actions.ts export, for the same
   * empty-tuple reason `loaderArity` exists. */
  actionArity: Record<string, number>;
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
): Map<string, Map<string, ExportInfo>> {
  const roots = EXPORT_BASES.flatMap((base) =>
    EXPORT_EXTS.map((ext) => join(appDir, base + ext)),
  );
  const handle = createProgram({ tsconfigPath, roots, session });

  const result = new Map<string, Map<string, ExportInfo>>();
  for (const base of EXPORT_BASES) {
    let exportsByName = new Map<string, ExportInfo>();
    if (handle) {
      for (const ext of EXPORT_EXTS) {
        const file = join(appDir, base + ext);
        if (handle.program.getSourceFile(file)) {
          exportsByName = new Map(moduleExports(handle.program, file).map((e) => [e.name, e]));
          break;
        }
      }
    }
    result.set(base, exportsByName);
  }
  return result;
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
  const formActions = new Set<string>();
  const actionArity: Record<string, number> = {};
  const loaderOrigins: Record<string, SpecPath> = {};
  const actionOrigins: Record<string, SpecPath> = {};
  const computeOrigins: Record<string, SpecPath> = {};

  const exportsByBase = exportsOf(ctx.appDir, ctx.config.tsconfigPath, ctx.session);
  const dataExports = exportsByBase.get("data") ?? new Map<string, ExportInfo>();
  const actionExports = exportsByBase.get("actions") ?? new Map<string, ExportInfo>();
  const computeExports = exportsByBase.get("compute") ?? new Map<string, ExportInfo>();

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
    const outDir = join(ctx.appDir, ctx.config.outDir);
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
  // rendering each state, so all three are validated against the catalog unconditionally.
  // But only pull a state component into the emitted import list where a generated page
  // actually renders it: loading/error appear only on a page that binds at least one
  // loader (see emitPages), and the empty state isn't rendered by any generated page yet
  // (see README limitations) — importing it unconditionally is exactly what produces an
  // unused-import error on a host with `noUnusedLocals`.
  const stateNames = {
    loading: ctx.config.states.loading,
    error: ctx.config.states.error,
    empty: ctx.config.states.empty,
  };
  const stateEntries = new Map<keyof typeof stateNames, ReturnType<Catalog["get"]>>();
  for (const [key, name] of Object.entries(stateNames) as [keyof typeof stateNames, string][]) {
    const entry = ctx.catalog.get(name);
    stateEntries.set(key, entry);
    if (!entry) {
      out.push(
        diagnostic(
          "NOVA2001",
          `state component '${name}' is not in any catalog`,
          ctx.positions.at([]),
          { hint: `available: ${ctx.catalog.names().join(", ")}` },
        ),
      );
    }
  }
  if (loaders.size > 0) {
    for (const key of ["loading", "error"] as const) {
      const entry = stateEntries.get(key);
      if (entry) addComponent(stateNames[key], specifierFromOutDir(entry.module, entry.file), ctx.positions.at([]));
    }
  }

  const fatal = out.some((d) => d.severity === "error");
  return {
    resolved: fatal
      ? null
      : {
          spec,
          components: [...components.values()].sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          ),
          loaders: sorted(loaders),
          actions: sorted(actions),
          computes: sorted(computes),
          loaderArity,
          formActions: sorted(formActions),
          actionArity,
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
    if (!qualifying.some((e) => e.name === name)) {
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
            loaderArity[ref.name] = dataExports.get(ref.name)!.paramCount;
          }
          if (loaderOrigins[ref.name] === undefined) loaderOrigins[ref.name] = [...at, propName];
        }
      } else if (ref.kind === "actions") {
        if (!actionExports.has(ref.name)) {
          report("NOVA2003", `actions.ts has no export '${ref.name}'`, propAt, actionExports, ref.name);
        } else {
          actions.add(ref.name);
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
