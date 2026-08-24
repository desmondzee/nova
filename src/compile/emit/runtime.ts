import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { hooksUsed } from "./pages.js";
import { HEADER, type EmittedFile } from "./types.js";

const USE_LOADER = [
  "export type LoaderState<T> = { loading: boolean; error: string | null; value: T | null };",
  "",
  "/**",
  " * Fetch JSON, discarding responses that arrive after a newer request started.",
  " *",
  " * `Input` is the loader's own declared parameter type. The query object nova builds",
  " * from the page's route params and filter values must satisfy it, so a loader input",
  " * that no param or filter supplies is a compile error at the call site rather than a",
  " * request that fails at runtime. It defaults to `unknown` (which intersects away) for",
  " * a loader declared with no parameters at all.",
  " */",
  "export function useLoader<T, Input = unknown>(",
  "  path: string,",
  "  query: Record<string, string> & Input,",
  "): LoaderState<T> {",
  "  const [state, setState] = React.useState<LoaderState<T>>({",
  "    loading: true,",
  "    error: null,",
  "    value: null,",
  "  });",
  "  const seq = React.useRef(0);",
  "  const key = JSON.stringify(query);",
  "  React.useEffect(() => {",
  "    const mine = ++seq.current;",
  "    setState((s) => ({ ...s, loading: true, error: null }));",
  "    const url = path + (key === '{}' ? '' : '?' + new URLSearchParams({ ...query }).toString());",
  "    fetch(url, { headers: { accept: 'application/json' } })",
  "      .then(async (r) => {",
  "        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);",
  "        return (await r.json()) as T;",
  "      })",
  "      .then((value) => {",
  "        if (seq.current === mine) setState({ loading: false, error: null, value });",
  "      })",
  "      .catch((e: unknown) => {",
  "        if (seq.current === mine) {",
  "          setState({ loading: false, error: e instanceof Error ? e.message : String(e), value: null });",
  "        }",
  "      });",
  "  }, [path, key]);",
  "  return state;",
  "}",
];

const USE_FILTERS = [
  "/**",
  " * Filter values, kept in the query string so a refresh preserves them.",
  " *",
  " * Keyed by the filter names the caller declares, not by an open index signature, so",
  " * `filters.month` is a `string` — not `string | undefined` — on a host that turns on",
  " * `noUncheckedIndexedAccess`.",
  " */",
  "export function useFilters<K extends string>(",
  "  defaults: Record<K, string>,",
  "): Record<K, string> & { set(name: K, value: string): void } {",
  "  const read = React.useCallback((): Record<string, string> => {",
  "    const search = new URLSearchParams(window.location.search);",
  "    const out: Record<string, string> = { ...defaults };",
  "    for (const name of Object.keys(defaults)) {",
  "      const v = search.get(name);",
  "      if (v !== null) out[name] = v;",
  "    }",
  "    return out;",
  "  }, [JSON.stringify(defaults)]);",
  "",
  "  const [values, setValues] = React.useState(read);",
  "  React.useEffect(() => {",
  "    const onPop = () => setValues(read());",
  "    window.addEventListener('popstate', onPop);",
  "    return () => window.removeEventListener('popstate', onPop);",
  "  }, [read]);",
  "",
  "  const set = React.useCallback((name: K, value: string) => {",
  "    const search = new URLSearchParams(window.location.search);",
  "    search.set(name, value);",
  "    window.history.replaceState(null, '', `${window.location.pathname}?${search.toString()}`);",
  "    setValues((v) => ({ ...v, [name]: value }));",
  "  }, []);",
  "",
  "  return React.useMemo(",
  "    () => ({ ...values, set }) as unknown as Record<K, string> & { set(name: K, value: string): void },",
  "    [values, set],",
  "  );",
  "}",
];

const USE_ACTION = [
  "export type ActionState = { busy: boolean; error: string | null; fieldErrors: Record<string, string> };",
  "",
  "/** Submit to an action endpoint, with optional confirmation and field errors. */",
  "export function useAction(",
  "  path: string,",
  "  opts: { confirm?: string } = {},",
  "): ActionState & { run(input: unknown): Promise<boolean> } {",
  "  const [state, setState] = React.useState<ActionState>({",
  "    busy: false,",
  "    error: null,",
  "    fieldErrors: {},",
  "  });",
  "  const run = React.useCallback(",
  "    async (input: unknown): Promise<boolean> => {",
  "      if (opts.confirm !== undefined && !window.confirm(opts.confirm)) return false;",
  "      setState({ busy: true, error: null, fieldErrors: {} });",
  "      try {",
  "        const r = await fetch(path, {",
  "          method: 'POST',",
  "          headers: { 'content-type': 'application/json' },",
  "          body: JSON.stringify(input),",
  "        });",
  "        const body = (await r.json()) as",
  "          | { ok: true }",
  "          | { ok: false; fieldErrors?: Record<string, string> };",
  "        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);",
  "        if (body.ok) {",
  "          setState({ busy: false, error: null, fieldErrors: {} });",
  "          return true;",
  "        }",
  "        setState({ busy: false, error: null, fieldErrors: body.fieldErrors ?? {} });",
  "        return false;",
  "      } catch (e: unknown) {",
  "        setState({",
  "          busy: false,",
  "          error: e instanceof Error ? e.message : String(e),",
  "          fieldErrors: {},",
  "        });",
  "        return false;",
  "      }",
  "    },",
  "    [path, opts.confirm],",
  "  );",
  "  return { ...state, run };",
  "}",
];

const USE_FORM = [
  "/**",
  " * One form's values, per-field errors, busy state and submission.",
  " *",
  " * `T` is the action's own declared input type, so `values[k]` and `set(k, v)` are",
  " * checked against it: a field naming a key the action does not accept, or bound to a",
  " * component whose value type does not match the key's, is a compile error.",
  " *",
  " * `T extends object` rather than `Record<string, unknown>` — an interface gets no",
  " * implicit index signature, so the stricter constraint would reject an action whose",
  " * input is declared as one, which is entirely ordinary.",
  " */",
  "export function useForm<T extends object>(",
  "  path: string,",
  "  initial: T,",
  "  opts: { confirm?: string } = {},",
  "): {",
  "  values: T;",
  "  errors: Partial<Record<keyof T & string, string>>;",
  "  busy: boolean;",
  "  error: string | null;",
  "  set<K extends keyof T & string>(key: K, value: T[K]): void;",
  "  submit(): Promise<boolean>;",
  "} {",
  "  const action = useAction(path, opts);",
  "  const [values, setValues] = React.useState<T>(initial);",
  "  const set = React.useCallback(<K extends keyof T & string>(key: K, value: T[K]): void => {",
  "    setValues((v) => ({ ...v, [key]: value }) as T);",
  "  }, []);",
  "  const submit = React.useCallback(() => action.run(values), [action, values]);",
  "  return {",
  "    values,",
  "    // The action reports errors keyed by whatever strings it likes. That they are T's",
  "    // keys is the one thing here TypeScript cannot know, so it is asserted once, here,",
  "    // rather than at every field.",
  "    errors: action.fieldErrors as Partial<Record<keyof T & string, string>>,",
  "    busy: action.busy,",
  "    error: action.error,",
  "    set,",
  "    submit,",
  "  };",
  "}",
];

/**
 * Emits only the hooks this app's `pages.tsx` will import, decided by the same
 * `hooksUsed` predicate that decides the import list itself — so the two files agree by
 * construction. Emitting all three unconditionally shipped 34 to 76 dead lines into
 * every generated app: a loaders-only app (the common shape) carried `useFilters` and
 * `useAction` it could never call, and `pages.ts` already went to careful lengths to
 * avoid importing them.
 *
 * An app that needs no hook at all gets an empty module rather than a bare `import * as
 * React` nothing uses — which a host with `noUnusedLocals` would fail on.
 */
export function emitRuntime(app: ResolvedApp, _config: NovaConfig): EmittedFile {
  const hooks = hooksUsed(app);
  const e = new Emitter();
  e.line(HEADER);

  const body = [
    ...(hooks.useLoader ? [USE_LOADER] : []),
    ...(hooks.useFilters ? [USE_FILTERS] : []),
    // useForm submits through useAction, so a form pulls it in even when no page calls
    // useAction directly — the one hook here that a page does not have to import.
    ...(hooks.useAction || hooks.useForm ? [USE_ACTION] : []),
    ...(hooks.useForm ? [USE_FORM] : []),
  ];

  if (body.length === 0) {
    e.line("// This spec binds no loader, no action, and no filter that anything reads,");
    e.line("// so there is no hook for pages.tsx to import.");
    e.line("export {};");
    return { name: "runtime.tsx", text: e.text(), map: e.map() };
  }

  e.line('"use client";');
  e.line();
  e.line('import * as React from "react";');
  for (const block of body) {
    e.line();
    e.lines(block);
  }
  return { name: "runtime.tsx", text: e.text(), map: e.map() };
}
