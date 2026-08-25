import { componentKey, type PropValue, type SectionSpec } from "../../schema/types.js";
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter, type SpecPath } from "./emitter.js";
import { HEADER, appRel, cap, rel, type EmittedFile } from "./types.js";

/**
 * The row type behind a loader's result, for a `sortable:` check that does not depend on
 * what a catalog calls its column prop.
 *
 * A non-array result falls back to an open record, whose `keyof … & string` is `string`
 * — so a section whose data is not a list of rows has nothing claimed about it rather
 * than a complaint invented for it.
 */
const ROW_OF =
  "type NovaRowOf<T> = T extends readonly (infer R)[] ? R : { [key: string]: unknown };";

/** The loaders one section binds through its own props (not its children's, not fields'). */
function ownLoaders(section: SectionSpec): string[] {
  const found = new Set<string>();
  for (const value of Object.values(section.props) as PropValue[]) {
    if (value.kind === "binding" && value.ref.kind === "data") found.add(value.ref.name);
  }
  return [...found].sort();
}

/** Every sortable section on the page, with the spec path of its `sortable:` key. */
function sortableSections(
  sections: SectionSpec[],
  path: SpecPath,
): { section: SectionSpec; at: SpecPath }[] {
  const out: { section: SectionSpec; at: SpecPath }[] = [];
  sections.forEach((section, i) => {
    const here = [...path, i];
    const key = componentKey(section.component);
    if (section.sortable !== undefined) {
      out.push({ section, at: [...here, key, "sortable"] });
    }
    out.push(...sortableSections(section.children, [...here, key, "children"]));
  });
  return out;
}

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
  if (app.loaders.length > 0) e.line(`import * as data from "${appRel(app, config, "data")}";`);
  if (app.actions.length > 0) e.line(`import * as actions from "${appRel(app, config, "actions")}";`);
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

  // `sortable:` against the *row type*, not against a prop that happens to be spelled
  // `columns`. NOVA1009 answers the same question from the spec's own text and can only
  // do so where the section names a literal `columns:` list — a catalog calling it
  // `cols`, `fields`, `headers` or `schema` got no check at all, which is a coupling to
  // the reference catalog's naming rather than to anything nova can claim. The row type
  // is what a sortable column has to be a key of, and TypeScript already knows it.
  //
  // Emitted only for a section binding exactly one loader: with two, there is no single
  // row type the columns belong to, and nova will not pick.
  const checks: { name: string; loader: string; columns: string[]; at: SpecPath }[] = [];
  for (const page of app.spec.pages) {
    for (const { section, at } of sortableSections(page.sections, ["pages", page.route, "sections"])) {
      const loaders = ownLoaders(section);
      const loader = loaders.length === 1 ? loaders[0]! : undefined;
      if (loader === undefined) continue;
      checks.push({
        name: `_sortable_${checks.length}`,
        loader,
        columns: section.sortable ?? [],
        at,
      });
    }
  }
  if (checks.length > 0) {
    e.line();
    e.line(ROW_OF);
    for (const check of checks) {
      e.line(
        `const ${check.name}: ReadonlyArray<keyof NovaRowOf<${cap(check.loader)}> & string> = ${JSON.stringify(check.columns)};`,
        check.at,
      );
      e.line(`void ${check.name};`);
    }
  }
  return { name: "__contract.ts", text: e.text(), map: e.map() };
}
