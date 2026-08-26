import { componentKey, type PropValue, type SectionSpec } from "../../schema/types.js";
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter, type SpecPath } from "./emitter.js";
import { HEADER, appRel, cap, rel, type EmittedFile } from "./types.js";

/**
 * The row type behind a loader's result, for a column check that does not depend on what
 * a catalog calls its column prop.
 *
 * A non-array result falls back to an open record, whose `keyof … & string` is `string`
 * — so a section whose data is not a list of rows has nothing claimed about it rather
 * than a complaint invented for it.
 */
const ROW_OF =
  "type NovaRowOf<T> = T extends readonly (infer R)[] ? R : { [key: string]: unknown };";

/**
 * The prop names a column list is written under by default, beside nova's own
 * `sortable:`.
 *
 * `columns:` is already the name the spec's own NOVA1009 reasons about ("is not one of
 * 'Table's columns"), and `numeric:` is the subset of that list a table right-aligns.
 * They are two prop names from one host's table component, though, which is the only
 * host knowledge in this codebase — so the list is `config.columnProps` and this is
 * merely its default. A catalog spelling its column list `cols` names it there and gets
 * the same check; a catalog whose `columns` prop carries display *labels* rather than
 * row keys sets `columnProps: []` and gets none, which it previously had no way to do.
 *
 * `sortable:` is checked whatever the list says: it is nova's own word, so its values
 * are row keys by definition and there is nothing to configure.
 */
const DEFAULT_COLUMN_PROPS = ["columns", "numeric"];

/**
 * The type expression for the value one section reads from a loader — `Order["lines"]`
 * for `rows: data#order.lines`, `Orders` for `rows: data#orders`.
 *
 * Only its own props count (not its children's, not its fields'), and only where they
 * name exactly one such value: with two, there is no single row type the columns belong
 * to, and nova will not pick. The path matters — a detail loader answers one object and a
 * table reads a list *inside* it, which the loader's own result type is not.
 */
function rowSource(section: SectionSpec): string | undefined {
  const found = new Set<string>();
  for (const value of Object.values(section.props) as PropValue[]) {
    if (value.kind === "binding" && value.ref.kind === "data") {
      found.add(
        [cap(value.ref.name), ...value.ref.path.map((p) => `[${JSON.stringify(p)}]`)].join(""),
      );
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Every column list on the page, with the spec path of the key that wrote it. */
function columnLists(
  sections: SectionSpec[],
  path: SpecPath,
  columnProps: string[],
): { section: SectionSpec; columns: string[]; at: SpecPath }[] {
  const out: { section: SectionSpec; columns: string[]; at: SpecPath }[] = [];
  sections.forEach((section, i) => {
    const here = [...path, i];
    const key = componentKey(section.component);
    if (section.sortable !== undefined) {
      out.push({ section, columns: section.sortable, at: [...here, key, "sortable"] });
    }
    for (const prop of columnProps) {
      const value = section.props[prop];
      if (
        value?.kind === "literal" &&
        Array.isArray(value.value) &&
        value.value.every((c) => typeof c === "string")
      ) {
        out.push({ section, columns: value.value as string[], at: [...here, key, prop] });
      }
    }
    out.push(...columnLists(section.children, [...here, key, "children"], columnProps));
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
//
// That is also why there is no *action* binding here any more. It was
// `const _saveOrder: SaveOrder = actions.saveOrder` where `SaveOrder` is
// `typeof actions.saveOrder` — an expression assigned to its own type, which no
// assignability rule can reject. A loader's binding restates its shape
// (`(input: …) => Promise<…>`) and so can fail; an action's restated nothing, and cost
// two lines per action, an import of `actions`, and a `${Cap}` alias, in every app.
export function emitContract(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER);
  e.line("// Typechecked, never executed. Diagnostics here are remapped to the spec.");
  e.line();
  if (app.loaders.length > 0) e.line(`import * as data from "${appRel(app, config, "data")}";`);
  const typeNames = app.loaders.flatMap((n) => [cap(n), `${cap(n)}Input`]);
  if (typeNames.length > 0) {
    e.line(`import type { ${[...new Set(typeNames)].sort().join(", ")} } from "${rel(config, "./types")}";`);
  }
  e.line();
  // Each binding is a local, and a local nothing reads fails a host with
  // `noUnusedLocals` — so they are discarded together, in one statement at the end,
  // rather than one `void _x;` line each. That halved this file in the apps that have
  // most of it: a page's worth of loaders used to emit a discard line apiece.
  const discards: string[] = [];
  for (const name of app.loaders) {
    // Mapped to the first spec binding that referenced this loader, not a
    // ["loaders", name] path — that path doesn't exist in the YAML document, so
    // positions.at() would silently fall back to the document root (1:1).
    e.line(
      `const _${name}: (input: ${cap(name)}Input) => Promise<${cap(name)}> = data.${name};`,
      app.loaderOrigins[name],
    );
    discards.push(`_${name}`);
  }

  // Every column list against the *row type*, not against a prop that happens to be
  // spelled `columns`. NOVA1009 answers a narrower question from the spec's own text —
  // whether a `sortable:` entry is in the section's own literal `columns:` — and cannot
  // say anything at all about whether either of them is a key of the data. The row type
  // is what a column has to be a key of, and TypeScript already knows it.
  //
  // `columns:` and `numeric:` were unchecked by both halves, so `columns: [dayz]`
  // compiled clean and rendered a column of en dashes on three production pages. They are
  // checked here now, on exactly the terms `sortable:` is.
  const checks: { name: string; row: string; columns: string[]; at: SpecPath }[] = [];
  for (const page of app.spec.pages) {
    for (const { section, columns, at } of columnLists(
      page.sections,
      ["pages", page.route, "sections"],
      config.columnProps ?? DEFAULT_COLUMN_PROPS,
    )) {
      const row = rowSource(section);
      if (row === undefined) continue;
      checks.push({ name: `_columns_${checks.length}`, row, columns, at });
    }
  }
  if (checks.length > 0) {
    e.line();
    e.line(ROW_OF);
    for (const check of checks) {
      e.line(
        `const ${check.name}: ReadonlyArray<keyof NovaRowOf<${check.row}> & string> = ${JSON.stringify(check.columns)};`,
        check.at,
      );
      discards.push(check.name);
    }
  }
  if (discards.length > 0) {
    e.line();
    e.line(`void [${discards.join(", ")}];`);
  }
  return { name: "__contract.ts", text: e.text(), map: e.map() };
}
