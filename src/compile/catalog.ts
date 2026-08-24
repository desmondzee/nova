import { diagnostic, type Diagnostic } from "../schema/diagnostic.js";
import type { NovaConfig } from "./config.js";
import { createProgram, moduleExports, resolveModule } from "./program.js";

export type CatalogEntry = { name: string; module: string; file: string };

export type Catalog = {
  get(name: string): CatalogEntry | undefined;
  names(): string[];
};

const isComponentName = (name: string) => /^[A-Z]/.test(name);

export function readCatalogs(
  config: NovaConfig,
  containingFile: string,
): { catalog: Catalog; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const at = { file: containingFile, line: 1, col: 1 };

  const resolved: { module: string; file: string }[] = [];
  for (const specifier of config.components) {
    const file = resolveModule(specifier, containingFile, config.tsconfigPath);
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
  });
  if (handle) {
    for (const { module, file } of resolved) {
      for (const exported of moduleExports(handle.program, file)) {
        if (!exported.callable || !isComponentName(exported.name)) continue;
        const existing = entries.get(exported.name);
        if (existing) {
          diagnostics.push(
            diagnostic(
              "NOVA2010",
              `component '${exported.name}' is exported by both '${existing.module}' and '${module}'`,
              at,
              { hint: "rename one, or remove a catalog from nova.config" },
            ),
          );
          continue;
        }
        entries.set(exported.name, { name: exported.name, module, file });
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
