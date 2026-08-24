export type BindingRef =
  | { kind: "data"; name: string; path: string[] }
  | { kind: "actions"; name: string }
  | { kind: "compute"; name: string }
  | { kind: "param"; name: string }
  /**
   * `filters.month` reads a filter; `filters.month.set` is the same reference in write
   * mode, and emits a `(value: string) => void` calling `useFilters`' setter. One
   * reference with two modes rather than a fourth namespace: the resolve-time check that
   * the page actually declares the filter (NOVA2006) then covers a typo in either form
   * with no extra code.
   */
  | { kind: "filter"; name: string; mode: "read" | "set" };

export type ComponentRef =
  | { kind: "catalog"; name: string }
  | { kind: "local"; module: string; name: string };

export type PropValue =
  | { kind: "literal"; value: unknown }
  | { kind: "binding"; ref: BindingRef };

export type SectionSpec = {
  component: ComponentRef;
  props: Record<string, PropValue>;
  children: SectionSpec[];
  /**
   * `confirm: "Delete this trip?"` — the message a generated page shows before running
   * the one action this section binds. Consumed by nova (it becomes `useAction`'s /
   * `useForm`'s `opts.confirm`) rather than forwarded as a prop, since a host component
   * that renders a delete button has no reason to declare a `confirm` prop of its own.
   */
  confirm?: string;
};

/**
 * A page filter: a named value kept in the query string, with an optional starting
 * value.
 *
 * There is deliberately no `type` here. It was required and read by nothing — no
 * widget, no coercion, no validation — so `type: month` and `type: mnoth` behaved
 * identically, and the README's own flagship example advertised month-awareness that
 * did not exist. `default` is likewise an ordinary literal: `default: current` shipped
 * the four-character string "current" to the loader, not the current month. Both are
 * gone rather than half-implemented; a spec that still spells `type:` gets NOVA1001
 * "unknown key" instead of a silent no-op.
 */
export type FilterSpec = { name: string; default?: unknown };

export type PageSpec = {
  route: string;
  title?: string;
  filters: FilterSpec[];
  sections: SectionSpec[];
};

export type AppSpec = { pages: PageSpec[] };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const upper = (s: string) => /^[A-Z]/.test(s);

export function parseBinding(text: string): BindingRef | null {
  const hash = text.indexOf("#");
  if (hash > 0) {
    const ns = text.slice(0, hash);
    const rest = text.slice(hash + 1);
    if (rest === "") return null;
    const [name, ...path] = rest.split(".");
    if (name === undefined || !IDENT.test(name)) return null;
    if (path.some((p) => !IDENT.test(p))) return null;
    if (ns === "data") return { kind: "data", name, path };
    if (path.length > 0) return null;
    if (ns === "actions") return { kind: "actions", name };
    if (ns === "compute") return { kind: "compute", name };
    return null;
  }
  if (text.startsWith("params.")) {
    const name = text.slice("params.".length);
    return IDENT.test(name) ? { kind: "param", name } : null;
  }
  if (text.startsWith("filters.")) {
    // `filters.month` reads; `filters.month.set` writes. Anything else — a deeper path,
    // or a trailing segment that is not `set` — is not a binding, so it falls through to
    // being treated as an ordinary string literal by the caller.
    const parts = text.slice("filters.".length).split(".");
    const [name, ...rest] = parts;
    if (name === undefined || !IDENT.test(name)) return null;
    if (rest.length === 0) return { kind: "filter", name, mode: "read" };
    if (rest.length === 1 && rest[0] === "set") return { kind: "filter", name, mode: "set" };
    return null;
  }
  return null;
}

export function parseComponentRef(text: string): ComponentRef | null {
  const hash = text.indexOf("#");
  if (hash < 0) {
    return IDENT.test(text) && upper(text) ? { kind: "catalog", name: text } : null;
  }
  const module = text.slice(0, hash);
  const name = text.slice(hash + 1);
  if (!module.startsWith(".") || !IDENT.test(name) || !upper(name)) return null;
  return { kind: "local", module, name };
}
