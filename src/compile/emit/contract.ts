import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { HEADER, cap, rel, type EmittedFile } from "./types.js";

export function emitContract(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER);
  e.line("// Typechecked, never executed. Diagnostics here are remapped to the spec.");
  e.line();
  if (app.loaders.length > 0) e.line(`import * as data from "${rel(config, "../data")}";`);
  if (app.actions.length > 0) e.line(`import * as actions from "${rel(config, "../actions")}";`);
  const typeNames = [...app.loaders.flatMap((n) => [cap(n), `${cap(n)}Input`]), ...app.actions.map(cap)];
  if (typeNames.length > 0) {
    e.line(`import type { ${[...new Set(typeNames)].sort().join(", ")} } from "${rel(config, "./types")}";`);
  }
  e.line();
  for (const name of app.loaders) {
    e.line(
      `const _${name}: (input: ${cap(name)}Input) => Promise<${cap(name)}> = data.${name};`,
      ["loaders", name],
    );
    e.line(`void _${name};`);
  }
  for (const name of app.actions) {
    e.line(`const _${name}: ${cap(name)} = actions.${name};`, ["actions", name]);
    e.line(`void _${name};`);
  }
  return { name: "__contract.ts", text: e.text(), map: e.map() };
}
