import { join } from "node:path";
import { diagnostic, suggest, type Diagnostic } from "../schema/diagnostic.js";
import type { AppSpec, PageSpec, SectionSpec } from "../schema/types.js";
import type { Catalog } from "./catalog.js";
import type { NovaConfig } from "./config.js";
import type { PositionMap } from "./load.js";
import { createProgram, moduleExports } from "./program.js";

export type ModuleBinding = { name: string; module: string };

export type ResolvedApp = {
  spec: AppSpec;
  components: ModuleBinding[];
  loaders: string[];
  actions: string[];
  computes: string[];
};

type Ctx = {
  config: NovaConfig;
  appDir: string;
  specFile: string;
  catalog: Catalog;
  positions: PositionMap;
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
function exportsOf(appDir: string, tsconfigPath: string): Map<string, Set<string>> {
  const roots = EXPORT_BASES.flatMap((base) =>
    EXPORT_EXTS.map((ext) => join(appDir, base + ext)),
  );
  const handle = createProgram({ tsconfigPath, roots });

  const result = new Map<string, Set<string>>();
  for (const base of EXPORT_BASES) {
    let exportsSet = new Set<string>();
    if (handle) {
      for (const ext of EXPORT_EXTS) {
        const file = join(appDir, base + ext);
        if (handle.program.getSourceFile(file)) {
          exportsSet = new Set(moduleExports(handle.program, file).map((e) => e.name));
          break;
        }
      }
    }
    result.set(base, exportsSet);
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

  const exportsByBase = exportsOf(ctx.appDir, ctx.config.tsconfigPath);
  const dataExports = exportsByBase.get("data") ?? new Set<string>();
  const actionExports = exportsByBase.get("actions") ?? new Set<string>();
  const computeExports = exportsByBase.get("compute") ?? new Set<string>();

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

  // Every generated page can render these three states, so they are always imported.
  for (const name of [ctx.config.states.loading, ctx.config.states.error, ctx.config.states.empty]) {
    const entry = ctx.catalog.get(name);
    if (!entry) {
      out.push(
        diagnostic(
          "NOVA2001",
          `state component '${name}' is not in any catalog`,
          ctx.positions.at([]),
          { hint: `available: ${ctx.catalog.names().join(", ")}` },
        ),
      );
      continue;
    }
    components.set(name, { name, module: entry.module });
  }

  const fatal = out.some((d) => d.severity === "error");
  return {
    resolved: fatal
      ? null
      : {
          spec,
          components: [...components.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
          loaders: sorted(loaders),
          actions: sorted(actions),
          computes: sorted(computes),
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
      if (section.component.kind === "catalog") {
        const name = section.component.name;
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
          components.set(name, { name, module: entry.module });
        }
      } else {
        components.set(`${section.component.module}#${section.component.name}`, {
          name: section.component.name,
          module: section.component.module,
        });
      }

      for (const propName of Object.keys(section.props).sort()) {
        const value = section.props[propName]!;
        if (value.kind !== "binding") continue;
        const ref = value.ref;
        const propAt = ctx.positions.at([...at, propName]);
        if (ref.kind === "data") {
          if (!dataExports.has(ref.name)) {
            report("NOVA2002", `data.ts has no export '${ref.name}'`, propAt, dataExports, ref.name);
          } else loaders.add(ref.name);
        } else if (ref.kind === "actions") {
          if (!actionExports.has(ref.name)) {
            report("NOVA2003", `actions.ts has no export '${ref.name}'`, propAt, actionExports, ref.name);
          } else actions.add(ref.name);
        } else if (ref.kind === "compute") {
          if (!computeExports.has(ref.name)) {
            report("NOVA2004", `compute.ts has no export '${ref.name}'`, propAt, computeExports, ref.name);
          } else computes.add(ref.name);
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

      walk(section.children, page, routeParams, filterNames, [...at, "children"]);
    });
  }

  function report(
    code: string,
    message: string,
    at: { file: string; line: number; col: number },
    available: Set<string>,
    name: string,
  ): void {
    const s = suggest(name, [...available]);
    out.push(diagnostic(code, message, at, s === undefined ? {} : { hint: `did you mean '${s}'?` }));
  }
}
