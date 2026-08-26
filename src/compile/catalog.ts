import { diagnostic, type Diagnostic, type Position } from "../schema/diagnostic.js";
import type { NovaConfig } from "./config.js";
import { createProgram, moduleExports, resolveModule, type ProgramSession } from "./program.js";

export type CatalogEntry = {
  /** Module specifier as `components:` wrote it, and the file it resolved to. The name
   * is not repeated here: it is the key every entry is looked up by. */
  module: string;
  file: string;
  /**
   * Where the component itself is declared — which is `file` for a catalog that exports
   * its components directly, and the component's own module for a catalog that is an
   * index of re-exports. Read to give the loser of a NOVA2010 collision a "declared
   * here" position: the diagnostic is reported against `app.yaml:1:1`, because the spec
   * is not what is wrong, so without this there is nothing in it pointing at either
   * declaration.
   */
  at: Position;
  /** The export's type parameters, carried through so the emitter can decide whether it
   * has a type argument to write. See ExportInfo.typeParams. */
  typeParams: { total: number; required: number };
};

export type Catalog = {
  get(name: string): CatalogEntry | undefined;
  names(): string[];
};

/**
 * The admission rule for a usable component, shared with `resolve.ts` so a catalog
 * export and a local-module export are judged by the same test: only a capitalised name
 * can appear in JSX as a component (a lowercase one is an intrinsic element).
 */
export const isComponentName = (name: string) => /^[A-Z]/.test(name);

export function readCatalogs(
  config: NovaConfig,
  containingFile: string,
  session?: ProgramSession,
): { catalog: Catalog; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const at = { file: containingFile, line: 1, col: 1 };

  const resolved: { module: string; file: string }[] = [];
  for (const specifier of config.components) {
    const file = resolveModule(specifier, containingFile, config.tsconfigPath, session);
    if (file === null) {
      diagnostics.push(
        diagnostic("NOVA2000", `cannot resolve catalog module '${specifier}'`, at, {
          hint: "check nova.config components against the host's tsconfig paths",
        }),
      );
      continue;
    }
    resolved.push({ module: specifier, file });
  }

  const entries = new Map<string, CatalogEntry>();
  const handle = createProgram({
    tsconfigPath: config.tsconfigPath,
    roots: resolved.map((r) => r.file),
    session,
  });
  if (handle) {
    for (const { module, file } of resolved) {
      for (const exported of moduleExports(handle.program, file)) {
        if (!exported.callable || !isComponentName(exported.name)) continue;
        const declaredAt: Position = {
          file: exported.file,
          line: exported.line,
          col: exported.col,
        };
        const existing = entries.get(exported.name);
        if (existing) {
          diagnostics.push(
            diagnostic(
              "NOVA2010",
              `component '${exported.name}' is exported by both '${existing.module}' and '${module}'`,
              at,
              {
                hint: "rename one, or remove a catalog from nova.config",
                // Both ends, in `components:` order: the catalogs are named in the
                // message, but which file to open is not derivable from a specifier.
                related: [
                  { ...existing.at, message: `'${existing.module}' declares it here` },
                  { ...declaredAt, message: `'${module}' declares it here` },
                ],
              },
            ),
          );
          continue;
        }
        entries.set(exported.name, { module, file, at: declaredAt, typeParams: exported.typeParams });
      }
    }
  } else {
    diagnostics.push(
      diagnostic("NOVA2011", `cannot read or parse tsconfig '${config.tsconfigPath}'`, at, {
        hint: "check that tsconfigPath points to a valid, readable tsconfig.json",
      }),
    );
  }

  const catalog: Catalog = {
    get: (name) => entries.get(name),
    names: () => [...entries.keys()].sort(),
  };
  return { catalog, diagnostics };
}
