import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { hooksUsed } from "./pages.js";
import { HEADER, type EmittedFile } from "./types.js";

/**
 * Every emitted docblock in this file is deliberately brief, and the reasoning behind
 * each hook lives here — in the compiler — rather than in the string it emits. The
 * distinction is what the two copies cost: a line here is written once, a line in the
 * arrays below is committed into every app's `generated/runtime.tsx`. The emitted
 * comments were 72 to 83 lines per app, about a third of the file, identical in all of
 * them; they are 27 to 33 now. Nothing was lost — every paragraph that was doing work is
 * still here, beside the code it is about.
 *
 * `useLoader`: `Input` is the loader's own declared parameter type, so the query object
 * nova assembles from the page's route params and filter values has to satisfy it — a
 * loader input that no param or filter supplies is a compile error at the call site
 * rather than a request that fails at runtime. It defaults to `unknown` (which
 * intersects away) for a loader declared with no parameters at all.
 *
 * The `!r.ok` branch reads the response body before it throws, and must keep doing so:
 * the handler answers `{ ok: false, error }` for a thrown error carrying a status, and
 * discarding that body is what turned `This order no longer exists.` into
 * `500 Internal Server Error`. The status line is only the fallback.
 */
const USE_LOADER = [
  "export type LoaderState<T> = { loading: boolean; error: string | null; value: T | null };",
  "",
  "/**",
  " * Fetch JSON, discarding responses that arrive after a newer request started.",
  " * `Input` is the loader's own parameter type; `reload()` re-requests the same URL.",
  " */",
  "export function useLoader<T, Input = unknown>(",
  "  path: string,",
  "  query: Record<string, string> & Input,",
  "): LoaderState<T> & { reload(): void } {",
  "  const [state, setState] = React.useState<LoaderState<T>>({",
  "    loading: true,",
  "    error: null,",
  "    value: null,",
  "  });",
  "  const seq = React.useRef(0);",
  "  const [nonce, setNonce] = React.useState(0);",
  "  const reload = React.useCallback(() => setNonce((n) => n + 1), []);",
  "  const key = JSON.stringify(query);",
  "  React.useEffect(() => {",
  "    const mine = ++seq.current;",
  "    setState((s) => ({ ...s, loading: true, error: null }));",
  "    const url = path + (key === '{}' ? '' : '?' + new URLSearchParams({ ...query }).toString());",
  "    fetch(url, { headers: { accept: 'application/json' } })",
  "      .then(async (r) => {",
  "        if (!r.ok) {",
  "          // The failure the loader itself described, where it described one.",
  "          const failed = (await r.json().catch(() => null)) as { error?: unknown } | null;",
  "          throw new Error(",
  "            typeof failed?.error === 'string' ? failed.error : `${r.status} ${r.statusText}`,",
  "          );",
  "        }",
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
  "  }, [path, key, nonce]);",
  "  return { ...state, reload };",
  "}",
];

/**
 * The fragment is the part of this that is not obvious and must not be dropped: a
 * hash-routed SPA — the ordinary choice for a statically hosted app — keeps its whole
 * route there, and writing `pathname + '?' + search` destroyed it the moment a filter or
 * a column was touched.
 */
const HREF = [
  "/** The URL for a new query string, keeping the path and the fragment. */",
  "function href(search: URLSearchParams): string {",
  "  return `${window.location.pathname}?${search.toString()}${window.location.hash}`;",
  "}",
];

/**
 * Two things here are load-bearing and look like they could be simplified.
 *
 * The return type is keyed by the filter names the caller declares rather than by an
 * open index signature, so `filters.month` is a `string` — not `string | undefined` — on
 * a host that turns on `noUncheckedIndexedAccess`.
 *
 * And the state is seeded from the defaults and reconciled with the URL *inside the
 * effect*, never in the `useState` initialiser: a client component is server-rendered
 * first, where reading `window` is a 500 rather than a hydration warning.
 */
const USE_FILTERS = [
  "/**",
  " * Filter values, kept in the query string so a refresh preserves them. Keyed by the",
  " * declared names, and seeded from the defaults until the effect reads the URL.",
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
  "  const [values, setValues] = React.useState<Record<string, string>>(() => ({ ...defaults }));",
  "  React.useEffect(() => {",
  "    setValues(read());",
  "    const onPop = () => setValues(read());",
  "    window.addEventListener('popstate', onPop);",
  "    return () => window.removeEventListener('popstate', onPop);",
  "  }, [read]);",
  "",
  "  const set = React.useCallback((name: K, value: string) => {",
  "    const search = new URLSearchParams(window.location.search);",
  "    search.set(name, value);",
  "    window.history.replaceState(null, '', href(search));",
  "    setValues((v) => ({ ...v, [name]: value }));",
  "  }, []);",
  "",
  "  return React.useMemo(",
  "    () => ({ ...values, set }) as unknown as Record<K, string> & { set(name: K, value: string): void },",
  "    [values, set],",
  "  );",
  "}",
];

/**
 * `Input` is the action's own declared parameter type, and `run` is declared as a
 * *property* rather than a method so that parameter is checked contravariantly: bound to
 * a component prop, it is then accepted only by a callback whose argument the action can
 * actually take. Writing it as `run(input: Input)` makes the check bivariant and gives
 * that away silently.
 *
 * `Result` is the action's own declared return type, and `run` resolves it rather than a
 * verdict nova reduced it to. An action that succeeds while reporting something
 * recoverable (`{ ok: true, warning }`) reads as a plain success under a boolean, so a
 * submission the upstream had accepted was shown to the reader as a failure, with the
 * row already written and the list un-refreshed behind it. `null` is the action having
 * given no answer at all — the confirmation was declined, or the request failed — and
 * the message for that is in `error`.
 *
 * `refresh` runs only where the action reports ok: field errors changed nothing, so
 * re-reading would be a request for the same rows.
 */
const USE_ACTION = [
  "export type ActionState = { busy: boolean; error: string | null; fieldErrors: Record<string, string> };",
  "",
  "/**",
  " * Submit to an action endpoint, with optional confirmation and refresh.",
  " *",
  " * `run` resolves the action's own result, or `null` where it gave no answer at all —",
  " * the confirmation was declined, or the request failed, and the message is in `error`.",
  " */",
  "export function useAction<Input = unknown, Result = unknown>(",
  "  path: string,",
  "  opts: { confirm?: string; refresh?: () => void } = {},",
  "): ActionState & { run: (input: Input) => Promise<Result | null> } {",
  "  const [state, setState] = React.useState<ActionState>({",
  "    busy: false,",
  "    error: null,",
  "    fieldErrors: {},",
  "  });",
  "  const run = React.useCallback(",
  "    async (input: Input): Promise<Result | null> => {",
  "      if (opts.confirm !== undefined && !window.confirm(opts.confirm)) return null;",
  "      setState({ busy: true, error: null, fieldErrors: {} });",
  "      try {",
  "        const r = await fetch(path, {",
  "          method: 'POST',",
  "          headers: { 'content-type': 'application/json' },",
  "          body: JSON.stringify(input),",
  "        });",
  "        if (!r.ok) {",
  "          // The refusal the action itself wrote, where it wrote one.",
  "          const failed = (await r.json().catch(() => null)) as { error?: unknown } | null;",
  "          throw new Error(",
  "            typeof failed?.error === 'string' ? failed.error : `${r.status} ${r.statusText}`,",
  "          );",
  "        }",
  "        const answer: unknown = await r.json();",
  "        // The two keys this hook reads; every other one is handed on untouched.",
  "        const shape = answer as { ok?: unknown; fieldErrors?: Record<string, string> } | null;",
  "        if (shape?.ok === true) {",
  "          setState({ busy: false, error: null, fieldErrors: {} });",
  "          opts.refresh?.();",
  "        } else {",
  "          setState({ busy: false, error: null, fieldErrors: shape?.fieldErrors ?? {} });",
  "        }",
  "        return answer as Result;",
  "      } catch (e: unknown) {",
  "        setState({",
  "          busy: false,",
  "          error: e instanceof Error ? e.message : String(e),",
  "          fieldErrors: {},",
  "        });",
  "        return null;",
  "      }",
  "    },",
  "    [path, opts.confirm, opts.refresh],",
  "  );",
  "  return { ...state, run };",
  "}",
];

/**
 * Ordering the rows is the table component's business (D3); this owns only the state and
 * its round trip through the URL. Seeded unsorted and reconciled with the URL inside the
 * effect, for the server-render reason `useFilters` is.
 */
const USE_SORT = [
  "export type SortState = { column: string; direction: 'asc' | 'desc' } | null;",
  "",
  "/**",
  " * The column a page is sorted by, kept in the query string beside its filters.",
  " * Selecting the current column reverses it; ordering the rows is the component's job.",
  " */",
  "export function useSort(): { value: SortState; set(column: string): void } {",
  "  const read = React.useCallback((): SortState => {",
  "    const search = new URLSearchParams(window.location.search);",
  "    const column = search.get('sort');",
  "    return column === null",
  "      ? null",
  "      : { column, direction: search.get('dir') === 'desc' ? 'desc' : 'asc' };",
  "  }, []);",
  "",
  "  const [value, setValue] = React.useState<SortState>(null);",
  "  React.useEffect(() => {",
  "    setValue(read());",
  "    const onPop = () => setValue(read());",
  "    window.addEventListener('popstate', onPop);",
  "    return () => window.removeEventListener('popstate', onPop);",
  "  }, [read]);",
  "",
  "  // The URL decides the direction to flip, not a setState updater: an updater may be",
  "  // re-run, and writing history from inside one pushes the same toggle twice.",
  "  const set = React.useCallback((column: string) => {",
  "    const search = new URLSearchParams(window.location.search);",
  "    const direction =",
  "      search.get('sort') === column && search.get('dir') !== 'desc' ? 'desc' : 'asc';",
  "    search.set('sort', column);",
  "    search.set('dir', direction);",
  "    window.history.replaceState(null, '', href(search));",
  "    setValue({ column, direction });",
  "  }, []);",
  "",
  "  return { value, set };",
  "}",
];

/**
 * `T` is the action's own declared input type, so `values[k]` and `set(k, v)` are
 * checked against it: a field naming a key the action does not accept, or bound to a
 * component whose value type does not match the key's, is a compile error at that
 * field's own spec line. This is the whole of the form check, and it is TypeScript's
 * rather than a comparator nova maintains.
 *
 * The constraint is `T extends object` rather than `Record<string, unknown>` on purpose:
 * an interface gets no implicit index signature, so the stricter constraint would reject
 * an action whose input is declared as one, which is entirely ordinary.
 */
const USE_FORM = [
  "/**",
  " * One form's values, per-field errors, busy state and submission. `T` is the action's",
  " * own input type, so `values[k]` and `set(k, v)` are checked against it.",
  " */",
  "export function useForm<T extends object>(",
  "  path: string,",
  "  initial: T,",
  "  opts: { confirm?: string; refresh?: () => void } = {},",
  "): {",
  "  values: T;",
  "  errors: Partial<Record<keyof T & string, string>>;",
  "  busy: boolean;",
  "  error: string | null;",
  "  set<K extends keyof T & string>(key: K, value: T[K]): void;",
  "  submit(): Promise<boolean>;",
  "} {",
  "  // A form needs one bit of the answer — whether the submission stood — and reads it",
  "  // off the action's own `ok`.",
  "  const action = useAction<T, { ok?: unknown }>(path, opts);",
  "  const [values, setValues] = React.useState<T>(initial);",
  "  const set = React.useCallback(<K extends keyof T & string>(key: K, value: T[K]): void => {",
  "    setValues((v) => ({ ...v, [key]: value }) as T);",
  "  }, []);",
  "  const submit = React.useCallback(",
  "    async (): Promise<boolean> => (await action.run(values))?.ok === true,",
  "    [action, values],",
  "  );",
  "  return {",
  "    values,",
  "    // That the action's error keys are T's is the one thing TypeScript cannot know,",
  "    // so it is asserted once here rather than at every field.",
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
    // Shared by the two hooks that write the query string, and emitted only where one of
    // them is — a module carrying a function nothing calls fails a host with
    // `noUnusedLocals`, which is the same rule every hook here is chosen by.
    ...(hooks.useFilters || hooks.useSort ? [HREF] : []),
    ...(hooks.useFilters ? [USE_FILTERS] : []),
    ...(hooks.useSort ? [USE_SORT] : []),
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
