import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { HEADER, appRel, cap, rel, type EmittedFile } from "./types.js";

// NOTE ON COVERAGE: every type asserted below (`XxxInput`, `Xxx`) is itself derived from
// the very export it is then assigned to (`Parameters<typeof data.x>[0]`,
// `Awaited<ReturnType<typeof data.x>>`), so this file cannot catch a mismatch between
// what the spec expects and what data.ts/actions.ts actually returns — it can only fail
// on loader arity (too many required parameters for the single input object nova
// supplies) or a loader that isn't async (a non-Promise return fails the `=> Promise<...>`
// assignment). The actual spec-to-code seam — whether a loader's return type or an
// action's input type matches what the bound component prop expects — is covered by
// pages.tsx's JSX, which is always one of the emitted, typechecked files.
export function emitContract(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER);
  e.line("// Typechecked, never executed. Diagnostics here are remapped to the spec.");
  e.line();
  if (app.loaders.length > 0) e.line(`import * as data from "${appRel(config, "data")}";`);
  if (app.actions.length > 0) e.line(`import * as actions from "${appRel(config, "actions")}";`);
  const typeNames = [...app.loaders.flatMap((n) => [cap(n), `${cap(n)}Input`]), ...app.actions.map(cap)];
  if (typeNames.length > 0) {
    e.line(`import type { ${[...new Set(typeNames)].sort().join(", ")} } from "${rel(config, "./types")}";`);
  }
  e.line();
  for (const name of app.loaders) {
    // Mapped to the first spec binding that referenced this loader, not a
    // ["loaders", name] path — that path doesn't exist in the YAML document, so
    // positions.at() would silently fall back to the document root (1:1).
    e.line(
      `const _${name}: (input: ${cap(name)}Input) => Promise<${cap(name)}> = data.${name};`,
      app.loaderOrigins[name],
    );
    e.line(`void _${name};`);
  }
  for (const name of app.actions) {
    e.line(`const _${name}: ${cap(name)} = actions.${name};`, app.actionOrigins[name]);
    e.line(`void _${name};`);
  }
  return { name: "__contract.ts", text: e.text(), map: e.map() };
}
