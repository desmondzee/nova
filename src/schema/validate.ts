import {
  diagnostic,
  suggest,
  type Diagnostic,
  type PositionMap,
  type SpecPath,
} from "./diagnostic.js";
import {
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
    checkPageActions(route, placed, report);

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
      if (raw.default !== undefined) filter.default = raw.default;
      filters.push(filter);
    }
    return filters;
  }

  /**
   * A generated page hoists one `useAction` per action, above every section that binds
   * it, so the confirmation text is a property of the action on that page rather than of
   * the section. Two sections asking for different text on the same action cannot both
   * be honoured, and silently picking one would ship a delete button with the wrong
   * prompt — so it is reported here instead.
   */
  function checkPageActions(
    route: string,
    placed: { path: Path; section: SectionSpec }[],
    report: typeof err,
  ): void {
    const seen = new Map<string, string | undefined>();
    const reported = new Set<string>();
    for (const { path, section } of placed) {
      for (const name of propActionsOf(section)) {
        if (!seen.has(name)) {
          seen.set(name, section.confirm);
          continue;
        }
        if (seen.get(name) === section.confirm || reported.has(name)) continue;
        reported.add(name);
        report(
          "NOVA1010",
          `action '${name}' is bound with two different confirmations on page '${route}' — one useAction is hoisted per action, so only one can be honoured`,
          path,
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
        rawFields = body.fields;
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

    if (rawFields !== undefined) {
      if (submit === undefined) {
        report(
          "NOVA1002",
          `'${key}' has fields but is missing required key 'submit' — a field edits a key of the action's input, so there has to be an action`,
          [...path, key, "fields"],
        );
      } else if (!Array.isArray(rawFields)) {
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

    if (confirm !== undefined) {
      // A confirmation guards an action, so there has to be exactly one to guard. Zero is
      // a spec that reads as if it confirms something and does not; more than one is
      // ambiguous, and nova will not pick.
      const bound = actionsBoundBy(section);
      if (bound.length === 1) {
        section.confirm = confirm;
      } else {
        report(
          "NOVA1007",
          bound.length === 0
            ? `'confirm' needs an action to guard, and '${key}' binds no action`
            : `'confirm' needs exactly one action to guard, and '${key}' binds ${bound.length} actions (${bound.join(", ")})`,
          [...path, key, "confirm"],
        );
      }
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
