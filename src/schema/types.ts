export type BindingRef =
  | { kind: "data"; name: string; path: string[] }
  | { kind: "actions"; name: string }
  | { kind: "compute"; name: string }
  | { kind: "param"; name: string }
  | { kind: "filter"; name: string };

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
};

export type FilterSpec = { name: string; type: string; default?: unknown };

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
  for (const [prefix, kind] of [
    ["params.", "param"],
    ["filters.", "filter"],
  ] as const) {
    if (text.startsWith(prefix)) {
      const name = text.slice(prefix.length);
      return IDENT.test(name) ? { kind, name } : null;
    }
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
