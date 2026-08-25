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

/**
 * One input in a form: a component reference, the key of the action's input type it
 * edits, and where that key starts.
 *
 * `name` is both the wiring and an ordinary prop — it is forwarded to the component (a
 * field usually needs it for its label's `htmlFor`) *and* used to bind `value`,
 * `onChange` and `error` against the action's declared input type.
 */
export type FieldSpec = {
  component: ComponentRef;
  name: string;
  /** Starting value. Defaults to `""`, which is right for the text-shaped majority. */
  initial: unknown;
  props: Record<string, PropValue>;
};

export type SectionSpec = {
  component: ComponentRef;
  props: Record<string, PropValue>;
  children: SectionSpec[];
  /**
   * `submit: actions#saveTrip` — the action this section's form submits. Present iff the
   * section is a form, which is what makes `fields:` meaningful and what makes nova
   * supply `onSubmit`, `busy` and `error`.
   */
  submit?: string;
  /** The form's fields. Only meaningful alongside `submit`. */
  fields?: FieldSpec[];
  /**
   * `sortable: [date, km]` — the columns this section lets the reader sort by. Wiring
   * *and* an ordinary prop: nova supplies `sort` and `onSort` from the page's sort
   * state, and forwards the list itself so the component knows which headers to make
   * clickable. Ordering the rows stays the component's business (D3).
   */
  sortable?: string[];
  /**
   * `confirm: "Delete this trip?"` — the message a generated page shows before running
   * the one action this section binds. Consumed by nova (it becomes `useAction`'s /
   * `useForm`'s `opts.confirm`) rather than forwarded as a prop, since a host component
   * that renders a delete button has no reason to declare a `confirm` prop of its own.
   */
  confirm?: string;
  /**
   * `refreshes: [trips]` — the page's loaders to re-read once the one action this section
   * runs has succeeded. Consumed by nova (it becomes the `refresh` callback on
   * `useAction`/`useForm`, which calls `reload()` on each named loader) rather than
   * forwarded, exactly as `confirm:` is. Deliberately the whole vocabulary: naming the
   * loaders is a page-local fact the spec already knows, and anything more would be a
   * cache.
   */
  refreshes?: string[];
};

/**
 * A page filter: a named value kept in the query string, with an optional starting
 * value.
 *
 * There is deliberately no `type` here. It was required and read by nothing — no
 * widget, no coercion, no validation — so `type: month` and `type: mnoth` behaved
 * identically, and the README's own flagship example advertised month-awareness that
 * did not exist. It is gone rather than half-implemented; a spec that still spells
 * `type:` gets NOVA1001 "unknown key" instead of a silent no-op.
 *
 * `default` is an ordinary prop value: a literal, or a `compute#` binding whose function
 * is called for the starting value. A binding rather than a sentinel because `current`
 * and `today` would be an untyped, host-specific vocabulary that only ever grows, while
 * `compute#currentMonth` reuses the binding machinery, keeps time handling in the app's
 * own code, and is checked against the `string` a filter holds by TypeScript. Any other
 * namespace is NOVA1013.
 */
export type FilterSpec = { name: string; default?: PropValue };

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

/**
 * The YAML key a component reference was written as — `Table`, or
 * `./views/charts#BridgeChart`.
 *
 * `SectionSpec` keeps the parsed reference rather than the raw key, but a spec path used
 * to look up a source position has to spell the document out exactly, and a section's
 * props and children sit *under* that key. Reconstructed here, once, so the emitter and
 * the resolver agree on it.
 */
export function componentKey(ref: ComponentRef): string {
  return ref.kind === "catalog" ? ref.name : `${ref.module}#${ref.name}`;
}
