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
  type FilterSpec,
  type PageSpec,
  type PropValue,
  type SectionSpec,
} from "./types.js";

const PAGE_KEYS = ["title", "filters", "sections"];
const FILTER_KEYS = ["type", "default"];
const ROUTE = /^\/$|^(?:\/(?:[A-Za-z0-9\-_]+|:[A-Za-z_$][A-Za-z0-9_$]*))+$/;

// Iteration order below is intentionally inconsistent: loops that build the emitted AppSpec
// (rawPages, filters, props) are sorted so downstream emission is byte-deterministic, while
// loops that only check for unknown keys follow document order so diagnostics read top-to-bottom
// in the order the author sees them in the source file.
type Path = SpecPath;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
    value.sections.forEach((raw, i) => {
      const s = validateSection(raw, [...path, "sections", i], report);
      if (s) sections.push(s);
    });

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
      if (typeof raw.type !== "string") {
        report("NOVA1002", `filter '${name}' is missing required key 'type'`, [...path, name]);
        continue;
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
      const filter: FilterSpec = { name, type: raw.type };
      if (raw.default !== undefined) filter.default = raw.default;
      filters.push(filter);
    }
    return filters;
  }

  function validateSection(value: unknown, path: Path, report: typeof err): SectionSpec | null {
    if (typeof value === "string") {
      const ref = parseComponentRef(value);
      if (!ref) {
        report("NOVA1004", `'${value}' is not a component reference`, path, componentHint(value));
        return null;
      }
      return { component: ref, props: {}, children: [] };
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
    if (body === null || body === undefined) return { component: ref, props: {}, children: [] };
    if (!isRecord(body)) {
      report("NOVA1003", `props for '${key}' must be a mapping`, [...path, key]);
      return null;
    }

    const props: Record<string, PropValue> = {};
    const children: SectionSpec[] = [];
    for (const prop of Object.keys(body).sort()) {
      if (prop === "children") {
        const raw = body.children;
        if (!Array.isArray(raw)) {
          report("NOVA1003", "'children' must be a list", [...path, key, "children"]);
          continue;
        }
        raw.forEach((child, i) => {
          const c = validateSection(child, [...path, key, "children", i], report);
          if (c) children.push(c);
        });
        continue;
      }
      props[prop] = toPropValue(body[prop]);
    }
    return { component: ref, props, children };
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
