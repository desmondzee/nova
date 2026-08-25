import {
  diagnostic,
  suggest,
  type Diagnostic,
  type PositionMap,
  type SpecPath,
} from "./diagnostic.js";
import {
  componentKey,
  parseBinding,
  parseComponentRef,
  type AppSpec,
  type FieldSpec,
  type FilterSpec,
  type PageSpec,
  type PropValue,
  type SectionSpec,
} from "./types.js";

const PAGE_KEYS = ["title", "filters", "sections"];
const FILTER_KEYS = ["default"];

/**
 * Props a generated page supplies itself, and which a spec therefore must not also set.
 *
 * Silently letting the spec win would drop the wiring that makes a form a form; silently
 * letting nova win would discard something the author wrote. Both are worse than saying
 * so. This is the same class of problem as a filter named `set`, so it reuses NOVA1001.
 */
const FORM_PROPS = ["busy", "error", "onSubmit"];
const FIELD_PROPS = ["error", "onChange", "value"];
const SORT_PROPS = ["onSort", "sort"];
const ROUTE = /^\/$|^(?:\/(?:[A-Za-z0-9\-_]+|:[A-Za-z_$][A-Za-z0-9_$]*))+$/;

// Iteration order below is intentionally inconsistent: loops that build the emitted AppSpec
// (rawPages, filters, props) are sorted so downstream emission is byte-deterministic, while
// loops that only check for unknown keys follow document order so diagnostics read top-to-bottom
// in the order the author sees them in the source file.
type Path = SpecPath;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Action names this section binds through an ordinary prop.
 *
 * Kept separate from a form's `submit:` because the two reach the page differently: a
 * prop binding shares the page's one hoisted `useAction` for that action, while a form
 * gets its own `useForm`. Only the first can conflict with another section.
 */
function propActionsOf(section: SectionSpec): string[] {
  const names = new Set<string>();
  for (const value of Object.values(section.props)) {
    if (value.kind === "binding" && value.ref.kind === "actions") names.add(value.ref.name);
  }
  return [...names].sort();
}

/** Every action this section runs, whether through a prop or through `submit:`. */
function actionsBoundBy(section: SectionSpec): string[] {
  const names = new Set(propActionsOf(section));
  if (section.submit !== undefined) names.add(section.submit);
  return [...names].sort();
}

export function validate(
  raw: unknown,
  positions: PositionMap,
): { spec: AppSpec | null; diagnostics: Diagnostic[] } {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, path: Path, hint?: string) => {
    out.push(diagnostic(code, message, positions.at(path), hint === undefined ? {} : { hint }));
  };

  if (!isRecord(raw)) {
    err("NOVA1003", "the spec must be a mapping", []);
    return { spec: null, diagnostics: out };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "pages") err("NOVA1001", `unknown key '${key}'`, [key], hintFor(key, ["pages"]));
  }
  const rawPages = raw.pages;
  if (rawPages === undefined) {
    err("NOVA1002", "missing required key 'pages'", []);
    return { spec: null, diagnostics: out };
  }
  if (!isRecord(rawPages)) {
    err("NOVA1003", "'pages' must be a mapping of route to page", ["pages"]);
    return { spec: null, diagnostics: out };
  }

  const pages: PageSpec[] = [];
  for (const route of Object.keys(rawPages).sort()) {
    const page = validatePage(route, rawPages[route], ["pages", route], err);
    if (page) pages.push(page);
  }

  const fatal = out.some((d) => d.severity === "error");
  return { spec: fatal ? null : { pages }, diagnostics: out };

  function hintFor(key: string, candidates: string[]): string | undefined {
    const s = suggest(key, candidates);
    return s === undefined ? undefined : `did you mean '${s}'?`;
  }

  function validatePage(
    route: string,
    value: unknown,
    path: Path,
    report: typeof err,
  ): PageSpec | null {
    if (!ROUTE.test(route)) {
      report("NOVA1005", `invalid route '${route}' — routes start with '/'`, path);
      return null;
    }
    if (!isRecord(value)) {
      report("NOVA1003", `page '${route}' must be a mapping`, path);
      return null;
    }
    for (const key of Object.keys(value)) {
      if (!PAGE_KEYS.includes(key)) {
        report("NOVA1001", `unknown key '${key}'`, [...path, key], hintFor(key, PAGE_KEYS));
      }
    }

    let title: string | undefined;
    if (value.title !== undefined) {
      if (typeof value.title !== "string") {
        report("NOVA1003", "'title' must be a string", [...path, "title"]);
      } else {
        title = value.title;
      }
    }

    const filters = validateFilters(value.filters, [...path, "filters"], report);

    if (value.sections === undefined) {
      report("NOVA1002", `page '${route}' is missing required key 'sections'`, path);
      return null;
    }
    if (!Array.isArray(value.sections)) {
      report("NOVA1003", "'sections' must be a list", [...path, "sections"]);
      return null;
    }
    const sections: SectionSpec[] = [];
    // Every section that validated, with the path it came from — page-level consistency
    // (below) needs both, and a path cannot be recovered from a SectionSpec afterwards
    // because a section that failed validation is dropped and shifts its siblings.
    const placed: { path: Path; section: SectionSpec }[] = [];
    value.sections.forEach((raw, i) => {
      const s = validateSection(raw, [...path, "sections", i], report, placed);
      if (s) sections.push(s);
    });
    checkPageConsistency(route, filters, [...path, "filters"], placed, report);

    const page: PageSpec = { route, filters, sections };
    if (title !== undefined) page.title = title;
    return page;
  }

  function validateFilters(value: unknown, path: Path, report: typeof err): FilterSpec[] {
    if (value === undefined) return [];
    if (!isRecord(value)) {
      report("NOVA1003", "'filters' must be a mapping", path);
      return [];
    }
    const filters: FilterSpec[] = [];
    for (const name of Object.keys(value).sort()) {
      const raw = value[name];
      if (!isRecord(raw)) {
        report("NOVA1003", `filter '${name}' must be a mapping`, [...path, name]);
        continue;
      }
      for (const key of Object.keys(raw)) {
        if (!FILTER_KEYS.includes(key)) {
          report("NOVA1001", `unknown key '${key}'`, [...path, name, key], hintFor(key, FILTER_KEYS));
        }
      }
      // useFilters returns { ...values, set }, so a filter literally named 'set' would
      // collide with the setter at runtime — reuse the "unknown key" code since this is
      // the same class of problem: a name that cannot be used in this position.
      if (name === "set") {
        report(
          "NOVA1001",
          "filter name 'set' is reserved — useFilters returns { ...values, set(...) }, so a filter named 'set' would collide with the setter",
          [...path, name],
        );
        continue;
      }
      const filter: FilterSpec = { name };
      if (raw.default !== undefined) {
        // A default is a value, not a callback: `compute#x` is *called* for it, which is
        // why no other namespace fits. `data#x` is asynchronous and arrives after the
        // filter has already fed its own loader; `actions#x` mutates; `params.`/`filters.`
        // are page state that does not exist yet at the moment a default is needed.
        const value = toPropValue(raw.default);
        if (value.kind === "binding" && value.ref.kind !== "compute") {
          report(
            "NOVA1013",
            `filter '${name}' has a ${value.ref.kind} binding as its default — a default is a literal or a compute# binding, which nova calls for the value`,
            [...path, name, "default"],
          );
        } else {
          filter.default = value;
        }
      }
      filters.push(filter);
    }
    return filters;
  }

  /**
   * Whole-page checks: things that are only wrong in combination, and which a
   * section-by-section pass therefore cannot see.
   *
   * A generated page hoists one `useAction` per action, above every section that binds
   * it, so the confirmation text is a property of the action on that page rather than of
   * the section. Two sections asking for different text on the same action cannot both
   * be honoured, and silently picking one would ship a delete button with the wrong
   * prompt — so it is reported here instead. Forms and sort state are hoisted the same
   * way and have the same problem.
   */
  function checkPageConsistency(
    route: string,
    filters: FilterSpec[],
    filtersPath: Path,
    placed: { path: Path; section: SectionSpec }[],
    report: typeof err,
  ): void {
    // `sort` and `dir` are nova's own two query parameters — `useSort` reads and writes
    // them on `window.location` — so a page that declares a filter by either name and
    // also has a sortable section has two owners for one parameter, which compiled
    // silently and then fought itself in the browser. They are also the two keys a
    // loader declares to have the sort reach it, so a filter of the same name would
    // decide what the loader is told about the sort. Only a page with a sortable section
    // is affected: without one nothing writes `?sort=`, and the name is the author's.
    const hasSortable = placed.some((p) => p.section.sortable !== undefined);
    if (hasSortable) {
      for (const filter of filters) {
        if (filter.name !== "sort" && filter.name !== "dir") continue;
        report(
          "NOVA1014",
          `filter name '${filter.name}' is reserved on page '${route}' — a sortable section keeps the page's sort state in '?sort=' and '?dir=', so both would write the same query parameter`,
          [...filtersPath, filter.name],
        );
      }
    }

    // Everything nova attaches to that one hoisted useAction, as one comparable value.
    const attached = (s: SectionSpec) => JSON.stringify([s.confirm ?? null, s.refreshes ?? null]);
    const seen = new Map<string, string>();
    const reported = new Set<string>();
    for (const { path, section } of placed) {
      for (const name of propActionsOf(section)) {
        if (!seen.has(name)) {
          seen.set(name, attached(section));
          continue;
        }
        if (seen.get(name) === attached(section) || reported.has(name)) continue;
        reported.add(name);
        report(
          "NOVA1010",
          `action '${name}' is bound with two different confirmations or refreshes on page '${route}' — one useAction is hoisted per action, so only one can be honoured`,
          path,
        );
      }
    }

    // `refreshes:` names loaders, and the only loaders a generated page holds are the
    // ones its own sections bind. A name that is not one of them would emit
    // `tirps.reload()` against a local that was never declared — a nova bug wearing a
    // spec error's clothes — so it is reported here, at the line that named it.
    const loaded = new Set<string>();
    for (const { section } of placed) {
      const props = [
        ...Object.values(section.props),
        ...(section.fields ?? []).flatMap((f) => Object.values(f.props)),
      ];
      for (const value of props) {
        if (value.kind === "binding" && value.ref.kind === "data") loaded.add(value.ref.name);
      }
    }
    for (const { path, section } of placed) {
      for (const name of section.refreshes ?? []) {
        if (loaded.has(name)) continue;
        report(
          "NOVA1012",
          `'${name}' is not a loader on page '${route}' — refreshes names loaders the page's own sections bind${
            loaded.size === 0 ? "" : ` (${[...loaded].sort().join(", ")})`
          }`,
          [...path, componentKey(section.component), "refreshes"],
          hintFor(name, [...loaded]),
        );
      }
    }

    // Same shape of problem, same code: a page hoists one `const <action>Form` per form,
    // so two forms submitting the same action would redeclare it — a nova bug that would
    // otherwise reach the author as a TypeScript redeclaration error on their own spec.
    const forms = new Set<string>();
    for (const { path, section } of placed) {
      if (section.submit === undefined) continue;
      if (forms.has(section.submit)) {
        report(
          "NOVA1010",
          `two forms on page '${route}' submit action '${section.submit}' — one useForm is hoisted per action, so give one of them its own action`,
          path,
        );
        continue;
      }
      forms.add(section.submit);
    }

    // One sort state per page, kept under `?sort=` and `?dir=` in the query string, so
    // it survives a refresh exactly as a filter does. Two sortable sections would write
    // to the same two parameters and read each other's answer back.
    const sortable = placed.filter((p) => p.section.sortable !== undefined);
    for (const { path } of sortable.slice(1)) {
      report(
        "NOVA1011",
        `page '${route}' has more than one sortable section, and a page holds one sort state`,
        path,
      );
    }
  }

  function validateSection(
    value: unknown,
    path: Path,
    report: typeof err,
    placed: { path: Path; section: SectionSpec }[],
  ): SectionSpec | null {
    const place = (section: SectionSpec): SectionSpec => {
      placed.push({ path, section });
      return section;
    };
    if (typeof value === "string") {
      const ref = parseComponentRef(value);
      if (!ref) {
        report("NOVA1004", `'${value}' is not a component reference`, path, componentHint(value));
        return null;
      }
      return place({ component: ref, props: {}, children: [] });
    }
    if (!isRecord(value)) {
      report("NOVA1003", "a section must be a string or a single-key mapping", path);
      return null;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      report("NOVA1003", `a section must have exactly one key, found ${keys.length}`, path);
      return null;
    }
    const key = keys[0]!;
    const ref = parseComponentRef(key);
    if (!ref) {
      report("NOVA1004", `'${key}' is not a component reference`, [...path, key], componentHint(key));
      return null;
    }
    const body = value[key];
    if (body === null || body === undefined) return place({ component: ref, props: {}, children: [] });
    if (!isRecord(body)) {
      report("NOVA1003", `props for '${key}' must be a mapping`, [...path, key]);
      return null;
    }

    const props: Record<string, PropValue> = {};
    const children: SectionSpec[] = [];
    let confirm: string | undefined;
    let submit: string | undefined;
    let rawFields: unknown;
    let rawRefreshes: unknown;
    for (const prop of Object.keys(body).sort()) {
      if (prop === "submit") {
        const ref = typeof body.submit === "string" ? parseBinding(body.submit) : null;
        if (ref === null || ref.kind !== "actions") {
          report(
            "NOVA1003",
            `'submit' must be an actions# binding, which is what makes '${key}' a form`,
            [...path, key, "submit"],
          );
        } else {
          submit = ref.name;
        }
        continue;
      }
      if (prop === "fields") {
        // Form vocabulary only where there is a form. `fields` is an entirely ordinary
        // prop name for a read-only component — a roster, a column list — and treating
        // it as a form's inputs unconditionally made every such component unusable
        // (NOVA1002: "has fields but is missing required key 'submit'") with no way to
        // escape but renaming the prop in the host's catalog. Without a `submit:` there
        // is no action whose input the entries could name, so the only thing left to do
        // with them is what nova does with every other prop: forward them, and let the
        // component's own type decide. A form that genuinely forgot its `submit:` still
        // fails — as a NOVA3001 at that section, where the field list meets a prop that
        // is not one.
        if (body.submit === undefined) {
          props[prop] = toPropValue(body[prop]);
          continue;
        }
        rawFields = body.fields;
        continue;
      }
      if (prop === "refreshes") {
        // Consumed by nova, like `confirm:` and unlike `sortable:` — a form shell has no
        // reason to declare a `refreshes` prop, so forwarding it would be a NOVA3001 on
        // every form that used one.
        rawRefreshes = body.refreshes;
        continue;
      }
      if (FORM_PROPS.includes(prop) && body.submit !== undefined) {
        report(
          "NOVA1001",
          `prop '${prop}' on a form is supplied by nova from its useForm state — remove it`,
          [...path, key, prop],
        );
        continue;
      }
      if (SORT_PROPS.includes(prop) && body.sortable !== undefined) {
        report(
          "NOVA1001",
          `prop '${prop}' on a sortable section is supplied by nova from the page's sort state — remove it`,
          [...path, key, prop],
        );
        continue;
      }
      if (prop === "children") {
        const raw = body.children;
        if (!Array.isArray(raw)) {
          report("NOVA1003", "'children' must be a list", [...path, key, "children"]);
          continue;
        }
        raw.forEach((child, i) => {
          const c = validateSection(child, [...path, key, "children", i], report, placed);
          if (c) children.push(c);
        });
        continue;
      }
      if (prop === "confirm") {
        if (typeof body.confirm !== "string") {
          report("NOVA1003", "'confirm' must be a string", [...path, key, "confirm"]);
        } else {
          confirm = body.confirm;
        }
        continue;
      }
      props[prop] = toPropValue(body[prop]);
    }

    const section: SectionSpec = { component: ref, props, children };
    if (submit !== undefined) section.submit = submit;

    if (body.sortable !== undefined) {
      const raw = body.sortable;
      if (!Array.isArray(raw) || raw.some((c) => typeof c !== "string")) {
        report("NOVA1003", "'sortable' must be a list of column names", [...path, key, "sortable"]);
      } else {
        // `columns:` is an ordinary prop, not spec vocabulary — a host table is free to
        // call it something else or feed it from a loader. Where the section does name a
        // literal list, a sortable column outside it is certainly a typo and is reported;
        // where it does not, there is nothing to check against and nothing is claimed.
        const declared = props.columns;
        const columns =
          declared?.kind === "literal" && Array.isArray(declared.value)
            ? declared.value.filter((c): c is string => typeof c === "string")
            : null;
        for (const column of raw as string[]) {
          if (columns !== null && !columns.includes(column)) {
            report(
              "NOVA1009",
              `'${column}' is sortable but is not one of '${key}'s columns (${columns.join(", ")})`,
              [...path, key, "sortable"],
              hintFor(column, columns),
            );
          }
        }
        section.sortable = raw as string[];
      }
    }

    if (rawFields !== undefined) {
      if (!Array.isArray(rawFields)) {
        report("NOVA1003", "'fields' must be a list", [...path, key, "fields"]);
      } else {
        const fields: FieldSpec[] = [];
        const names = new Set<string>();
        rawFields.forEach((raw, i) => {
          const field = validateField(raw, [...path, key, "fields", i], report);
          if (!field) return;
          if (names.has(field.name)) {
            // Two fields on one key emit a duplicate property in useForm's initial
            // object, which TypeScript reports against the form rather than the field
            // that actually repeats.
            report(
              "NOVA1008",
              `two fields edit '${field.name}' — a form holds one value per key of the action's input`,
              [...path, key, "fields", i],
            );
            return;
          }
          names.add(field.name);
          fields.push(field);
        });
        section.fields = fields;
      }
    }

    let refreshes: string[] | undefined;
    if (rawRefreshes !== undefined) {
      if (!Array.isArray(rawRefreshes) || rawRefreshes.some((n) => typeof n !== "string")) {
        report("NOVA1003", "'refreshes' must be a list of loader names", [
          ...path,
          key,
          "refreshes",
        ]);
      } else {
        refreshes = rawRefreshes as string[];
      }
    }

    // `confirm:` guards an action and `refreshes:` follows one, so each needs exactly one
    // action to attach to. Zero is a spec that reads as if it does something and does
    // not; more than one is ambiguous, and nova will not pick.
    const bound = actionsBoundBy(section);
    for (const word of ["confirm", "refreshes"] as const) {
      if ((word === "confirm" ? confirm : refreshes) === undefined || bound.length === 1) continue;
      report(
        "NOVA1007",
        bound.length === 0
          ? `'${word}' needs an action to attach to, and '${key}' binds no action`
          : `'${word}' needs exactly one action to attach to, and '${key}' binds ${bound.length} actions (${bound.join(", ")})`,
        [...path, key, word],
      );
    }
    if (bound.length === 1) {
      if (confirm !== undefined) section.confirm = confirm;
      if (refreshes !== undefined) section.refreshes = refreshes;
    }
    return place(section);
  }

  /**
   * One form field: the same single-key component mapping a section uses, plus a required
   * `name` naming the key of the action's input it edits, and an optional `initial`.
   *
   * `name` is checked here only for being present and a string. That it is a key the
   * action actually accepts is TypeScript's job (D5): the emitted `values[...]` /
   * `set(...)` calls are checked against the action's own declared input type, and the
   * diagnostic is remapped to this field's line.
   */
  function validateField(value: unknown, path: Path, report: typeof err): FieldSpec | null {
    if (!isRecord(value)) {
      report("NOVA1003", "a field must be a single-key mapping", path);
      return null;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      report("NOVA1003", `a field must have exactly one key, found ${keys.length}`, path);
      return null;
    }
    const key = keys[0]!;
    const ref = parseComponentRef(key);
    if (!ref) {
      report("NOVA1004", `'${key}' is not a component reference`, [...path, key], componentHint(key));
      return null;
    }
    const body = value[key];
    if (!isRecord(body)) {
      report("NOVA1003", `props for field '${key}' must be a mapping`, [...path, key]);
      return null;
    }
    if (body.name === undefined) {
      report(
        "NOVA1002",
        `field '${key}' is missing required key 'name' — the key of the action's input it edits`,
        [...path, key],
      );
      return null;
    }
    if (typeof body.name !== "string") {
      report("NOVA1003", "'name' must be a string", [...path, key, "name"]);
      return null;
    }

    const props: Record<string, PropValue> = {};
    for (const prop of Object.keys(body).sort()) {
      if (prop === "initial") continue;
      if (FIELD_PROPS.includes(prop)) {
        report(
          "NOVA1001",
          `prop '${prop}' on a field is supplied by nova from its form state — remove it`,
          [...path, key, prop],
        );
        continue;
      }
      props[prop] = toPropValue(body[prop]);
    }
    return { component: ref, name: body.name, initial: body.initial ?? "", props };
  }

  function componentHint(text: string): string | undefined {
    return /^[a-z]/.test(text)
      ? "component names start with a capital letter; lowercase names are HTML elements"
      : undefined;
  }

  function toPropValue(value: unknown): PropValue {
    if (typeof value === "string") {
      const ref = parseBinding(value);
      if (ref) return { kind: "binding", ref };
    }
    return { kind: "literal", value };
  }
}
