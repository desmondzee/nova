import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../src/compile/config.js";
import { compileApp } from "../src/compile/index.js";

// The three defects the equivalence audit of a converted production app found, each of
// which made the generated app *less* robust than the hand-written one it replaced:
//
//   §6.1  one failing loader out of five replaced the entire page;
//   §6.2  a stale detail link answered 500 where the original answered 404;
//   §4.2  a malformed request body answered 500 where the original answered 400.
//
// Every test here is behavioural: the emitted module is transpiled and *run*, against
// stubs standing in for React, the catalog and the app's own data.ts. Asserting that the
// emitted source contains a string would not have caught any of the three.
//
// A later audit of three converted production apps found three more of the same kind,
// and they are tested the same way:
//
//   §7.1  one failed loader rendered one error notice per section that bound it;
//   §7.3  a JSON `null` body answered 500 where the original answered 400;
//   §7.4  an action bound as a prop resolved only `boolean`, so a submission the upstream
//         accepted *with a warning* was shown to the user as an outright failure.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturesDir = here("./fixtures/");

const dirs: string[] = [];

function app(name: string): string {
  const root = mkdtempSync(join(fixturesDir, "tmp-degrade-"));
  dirs.push(root);
  cpSync(join(fixturesDir, name), join(root, name), { recursive: true });
  cpSync(join(fixturesDir, "tsconfig.json"), join(root, "tsconfig.json"));
  cpSync(join(fixturesDir, "tsconfig.strict.json"), join(root, "tsconfig.strict.json"));
  cpSync(join(fixturesDir, "catalog"), join(root, "catalog"), { recursive: true });
  return join(root, name);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui", "../catalog/forms"],
  states: { loading: "Loading", error: "ErrorNotice" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
});

const fileOf = (files: { name: string; text: string }[], name: string) =>
  files.find((f) => f.name === name)!.text;

/** Transpile one emitted module with the classic JSX factory and run it here. */
function evaluateModule(source: string, load: (specifier: string) => unknown): unknown {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      // Classic, not the automatic runtime: the elements then come from the `React`
      // stub this file supplies, which is what makes the tree readable below.
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("exports", "require", js)(exports, load);
  return exports;
}

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };

const React = {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) =>
    ({ type, props: props ?? {}, children }) as Node,
  Fragment: "Fragment",
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useRef: (value: unknown) => ({ current: value }),
};

/** Every component the page rendered, in document order, with its props. */
function rendered(
  root: unknown,
): { name: string; props: Record<string, unknown>; children: unknown[] }[] {
  const out: { name: string; props: Record<string, unknown>; children: unknown[] }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const n = node as Node;
    const type = n.type;
    if (typeof type === "function") {
      out.push({ name: type.name, props: n.props, children: n.children });
    }
    walk(n.children);
    walk(n.props?.["children"]);
  };
  walk(root);
  return out;
}

/**
 * A catalog stub: every name the emitted module imports resolves to a named function, so
 * `rendered` can report which components a page actually put on the screen.
 */
const catalogStub = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      const fn = () => null;
      Object.defineProperty(fn, "name", { value: name });
      return fn;
    },
  },
);

type LoaderState = { loading: boolean; error: string | null; value: unknown };

/** Run one emitted page with a canned answer for each loader. */
function renderPage(views: string, states: Record<string, LoaderState>): ReturnType<typeof rendered> {
  const mod = evaluateModule(views, (m) => {
    if (m === "react") return React;
    if (m.endsWith("/runtime")) {
      return {
        useLoader: (path: string) => {
          const name = path.slice(path.lastIndexOf("/") + 1);
          const state = states[name];
          if (!state) throw new Error(`no canned state for loader '${name}'`);
          return { ...state, reload: () => {} };
        },
        useFilters: (defaults: Record<string, string>) => ({ ...defaults, set: () => {} }),
        useAction: () => ({ busy: false, error: null, fieldErrors: {}, run: async () => true }),
        useForm: () => ({
          values: {},
          errors: {},
          busy: false,
          error: null,
          set: () => {},
          submit: async () => true,
        }),
      };
    }
    if (m.includes("catalog")) return catalogStub;
    throw new Error(`unexpected import ${m}`);
  }) as { Page_0: (p: { params: Record<string, string> }) => unknown };
  return rendered(mod.Page_0({ params: {} }));
}

const ok = (value: unknown): LoaderState => ({ loading: false, error: null, value });
const failed = (error: string): LoaderState => ({ loading: false, error, value: null });
const pending: LoaderState = { loading: true, error: null, value: null };

describe("§6.1 one failing loader degrades one section, not the page", () => {
  // Before: `const error = a.error ?? b.error ?? c.error; if (error) return <ErrorNotice>`
  // gated the whole page, so injecting a 500 into one of five loaders replaced the
  // navigation, the header, the stats, every section and both forms with one line. The
  // hand-written original renders everything it can and shows the failure in place.
  const seed = {
    trips: ok([{ date: "2026-08-01", km: 12 }]),
    monthlyTotal: ok("2026-08: 12 km"),
    policy: ok("policy for 2026-08"),
  };

  it("renders every section whose data arrived, and the error state only where it did not", async () => {
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const views = fileOf(result.files, "views.tsx");

    const names = renderPage(views, { ...seed, trips: failed("500 Internal Server Error") }).map(
      (c) => c.name,
    );

    // The failing loader's own section is replaced, in place, by the error state.
    expect(names).toContain("ErrorNotice");
    expect(names).not.toContain("Table");
    // …and everything else is still on the screen: the loader-free heading, the two
    // sections whose data arrived, and the panel the failed table lives inside.
    expect(names.filter((n) => n === "StatCard")).toHaveLength(3);
    expect(names).toContain("Panel");
    expect(names).not.toContain("Loading");
  });

  it("hands the failing section's own message to the error state", async () => {
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    const views = fileOf(result.files, "views.tsx");
    const notice = renderPage(views, { ...seed, policy: failed("HTTP 404") }).find(
      (c) => c.name === "ErrorNotice",
    );
    expect(notice).toBeDefined();
    expect(notice!.children).toEqual(["HTTP 404"]);
  });

  it("keeps the rest of the page while one section is still loading", async () => {
    // The first-paint half of the same defect (§6.4): the page used to render the word
    // `Loading` and nothing else until every loader had answered, so it server-rendered
    // no chrome at all. Now only the section that is waiting waits.
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    const views = fileOf(result.files, "views.tsx");
    const names = renderPage(views, { ...seed, trips: pending }).map((c) => c.name);
    expect(names).toContain("Loading");
    expect(names).not.toContain("Table");
    expect(names.filter((n) => n === "StatCard")).toHaveLength(3);
  });

  it("shows nothing but the sections themselves once every loader has answered", async () => {
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    const views = fileOf(result.files, "views.tsx");
    const names = renderPage(views, seed).map((c) => c.name);
    expect(names).not.toContain("ErrorNotice");
    expect(names).not.toContain("Loading");
    expect(names).toContain("Table");
    expect(names.filter((n) => n === "StatCard")).toHaveLength(3);
  });

  it("still narrows .value, so a component prop never receives null", async () => {
    // The page-level null check was what narrowed `trips.value` for every section at
    // once. Per-section rendering moves the narrowing into each section's own
    // conditional; if it were lost, this strict compile would report `Trip[] | null`.
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
    const views = fileOf(result.files, "views.tsx");
    expect(views).toContain("rows={trips.value}");
    // Nothing casts or asserts the null away — the narrowing is real.
    expect(views).not.toMatch(/\.value!/);
    expect(views).not.toMatch(/\.value as /);
  });
});

describe("§7.1 one failed loader reads once, however many sections bind it", () => {
  // The over-correction of §6.1. Per-section degradation is right, but the unit it chose
  // was the section, and a detail page hangs five sections off one loader — so a stale
  // link printed the same sentence four times. The reporting conversion printed six, and
  // the fourth of them replaced the card holding the controls that could have fixed it.
  it("renders one error notice where four sections bind the loader that failed", async () => {
    const appDir = app("app-detail");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const views = fileOf(result.files, "views.tsx");

    const names = renderPage(views, { travel: failed("This travel no longer exists.") }).map(
      (c) => c.name,
    );
    expect(names.filter((n) => n === "ErrorNotice")).toHaveLength(1);
    // The sections that needed the data are gone, and the one that never did is not.
    expect(names).not.toContain("Breakdown");
    expect(names.filter((n) => n === "StatCard")).toHaveLength(1);
  });

  it("puts the one notice where the first section that bound the loader was", async () => {
    const appDir = app("app-detail");
    const result = await compileApp(appDir, configFor(appDir));
    const shown = renderPage(fileOf(result.files, "views.tsx"), {
      travel: failed("This travel no longer exists."),
    });
    // The heading binds nothing and comes first; the notice stands in the position of
    // the first section that did bind the failed loader, not at the top or the bottom.
    expect(shown.map((c) => c.name)).toEqual(["StatCard", "ErrorNotice"]);
    expect(shown[1]!.children).toEqual(["This travel no longer exists."]);
  });

  it("still reads once per distinct failure, not once per page", async () => {
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    const names = renderPage(fileOf(result.files, "views.tsx"), {
      trips: failed("500 Internal Server Error"),
      monthlyTotal: ok("2026-08: 12 km"),
      policy: failed("HTTP 404"),
    }).map((c) => c.name);
    expect(names.filter((n) => n === "ErrorNotice")).toHaveLength(2);
  });

  it("leaves the loading state per section, because a placeholder is not a sentence", async () => {
    // Deliberately not deduplicated: `Loading` marks where a section will be, and four
    // spinners in four places is what a page that is still arriving looks like. Four
    // copies of one sentence is a claim made four times.
    const appDir = app("app-detail");
    const result = await compileApp(appDir, configFor(appDir));
    const names = renderPage(fileOf(result.files, "views.tsx"), { travel: pending }).map(
      (c) => c.name,
    );
    expect(names.filter((n) => n === "Loading")).toHaveLength(4);
  });
});

describe("§7.4 an action's own answer reaches the component that runs it", () => {
  /** What `useAction`'s `run` resolves to for a given answer, by running the hook. */
  async function runAgainst(runtime: string, answer: Response | Error): Promise<unknown> {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }) as typeof fetch;
    try {
      const mod = evaluateModule(runtime, (m) => {
        if (m === "react") return React;
        throw new Error(`unexpected import ${m}`);
      }) as { useAction: (p: string) => { run: (input: unknown) => Promise<unknown> } };
      return await mod.useAction("/_actions/submitMonth").run({ month: "2026-08" });
    } finally {
      globalThis.fetch = previous;
    }
  }

  const answered = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  /** What `run` leaves in `state.error` for a refused request. */
  async function messageOf(runtime: string, response: Response): Promise<string> {
    let captured = "";
    const stub = {
      ...React,
      useState: (init: unknown) => [
        typeof init === "function" ? (init as () => unknown)() : init,
        (next: unknown) => {
          const err = (next as { error?: unknown }).error;
          if (typeof err === "string") captured = err;
        },
      ],
    };
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => response) as typeof fetch;
    try {
      const mod = evaluateModule(runtime, (m) => {
        if (m === "react") return stub;
        throw new Error(`unexpected import ${m}`);
      }) as { useAction: (p: string) => { run: (input: unknown) => Promise<unknown> } };
      await mod.useAction("/_actions/submitMonth").run({ month: "2026-08" });
    } finally {
      globalThis.fetch = previous;
    }
    return captured;
  }

  it("type-checks a component prop declaring the action's own result type", async () => {
    // `run` resolved `Promise<boolean>`, so a prop that wanted the answer could not be
    // bound at all — and the two conversions that hit this declared `Promise<boolean>`
    // instead, which is how a warning became a failure.
    const appDir = app("app-outcome");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("distinguishes success-with-warning from success and from failure", async () => {
    const appDir = app("app-outcome");
    const result = await compileApp(appDir, configFor(appDir));
    const runtime = fileOf(result.files, "runtime.tsx");

    expect(await runAgainst(runtime, answered({ ok: true }))).toEqual({ ok: true });
    // The one the audit called a blocker: the claim persisted, and the user was told it
    // had not. `true` cannot carry this and `false` is a lie about it.
    expect(await runAgainst(runtime, answered({ ok: true, warning: "Expense left as a draft." })))
      .toEqual({ ok: true, warning: "Expense left as a draft." });
    expect(await runAgainst(runtime, answered({ ok: false, fieldErrors: { month: "required" } })))
      .toEqual({ ok: false, fieldErrors: { month: "required" } });
  });

  it("resolves null when the action never answered", async () => {
    const appDir = app("app-outcome");
    const result = await compileApp(appDir, configFor(appDir));
    const runtime = fileOf(result.files, "runtime.tsx");
    expect(await runAgainst(runtime, new Error("connection refused"))).toBeNull();
  });

  it("shows the refusal the action wrote, rather than discarding the body", async () => {
    // An action that throws a status-carrying error is answered with that status and
    // `{ ok: false, error }` — the same vocabulary a loader refuses in. `run` read only
    // the status line, so "You do not have access to invoice reporting." reached the
    // reader as `403 Forbidden`. Same defect, same fix, as §6.2 for loaders.
    const appDir = app("app-outcome");
    const result = await compileApp(appDir, configFor(appDir));
    const runtime = fileOf(result.files, "runtime.tsx");
    const refusal = new Response(
      JSON.stringify({ ok: false, error: "You do not have access to invoice reporting." }),
      { status: 403 },
    );
    expect(await messageOf(runtime, refusal)).toBe(
      "You do not have access to invoice reporting.",
    );
    // With no message on the wire the status line is still what the reader is told.
    expect(await messageOf(runtime, new Response("", { status: 403, statusText: "Forbidden" })))
      .toBe("403 Forbidden");
  });

  it("still gives a form a boolean verdict, and still clears the errors it cleared", async () => {
    // useForm builds on useAction and decides from "did the submit succeed" whether the
    // per-field errors stand. That verdict is now read off the action's own `ok` rather
    // than off a boolean `run` invented; the clearing itself was always useAction's own
    // state, and is unchanged.
    const appDir = app("app-form");
    const result = await compileApp(appDir, configFor(appDir));
    const runtime = fileOf(result.files, "runtime.tsx");
    expect(await submitAgainst(runtime, { ok: true })).toEqual({ verdict: true, errors: {} });
    expect(await submitAgainst(runtime, { ok: false, fieldErrors: { km: "too far" } })).toEqual({
      verdict: false,
      errors: { km: "too far" },
    });
  });
});

describe("§6.2 a loader carries its own status to the client", () => {
  /** Run one emitted handler map against a stub data.ts / actions.ts. */
  function handlersOf(
    text: string,
    data: Record<string, unknown>,
    actions: Record<string, unknown> = {},
  ): Record<string, (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>> {
    const mod = evaluateModule(text, (m) => {
      if (m.endsWith("/data")) return data;
      if (m.endsWith("/actions")) return actions;
      throw new Error(`unexpected import ${m}`);
    }) as { handlers: Record<string, never> };
    return mod.handlers;
  }

  it("answers a loader's own status, so a not-found reads as not-found", async () => {
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    const handlers = handlersOf(fileOf(result.files, "handlers.ts"), {
      trips: async () => {
        throw Object.assign(new Error("This trip no longer exists."), { status: 404 });
      },
      monthlyTotal: async () => "",
      policy: async () => "",
    });
    const res = await handlers["GET /_data/trips"]!(new Request("http://h/_data/trips?month=2026-08"), {
      params: {},
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "This trip no longer exists." });
  });

  it("lets an error with no status through, so the host still logs and answers it", async () => {
    // A genuine fault must stay a throw: the reference host logs one line per app error
    // and maps a storage outage to 503, and both need the exception, not a Response.
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    const handlers = handlersOf(fileOf(result.files, "handlers.ts"), {
      trips: async () => {
        throw new Error("connection refused");
      },
      monthlyTotal: async () => "",
      policy: async () => "",
    });
    await expect(
      handlers["GET /_data/trips"]!(new Request("http://h/_data/trips"), { params: {} }),
    ).rejects.toThrow("connection refused");
  });

  it("shows the message the loader wrote rather than discarding the body", async () => {
    // `useLoader` threw `${r.status} ${r.statusText}` and never read the body, so even a
    // loader that had written a sentence was rendered as `500 Internal Server Error`.
    const appDir = app("app-sections");
    const result = await compileApp(appDir, configFor(appDir));
    const runtime = fileOf(result.files, "runtime.tsx");
    const { useLoader } = (await runOneLoader(runtime)) as {
      useLoader: (path: string, q: Record<string, string>) => unknown;
    };
    expect(typeof useLoader).toBe("function");

    expect(await messageFor(runtime, new Response(JSON.stringify({ ok: false, error: "This trip no longer exists." }), { status: 404 }))).toBe(
      "This trip no longer exists.",
    );
    // With no message on the wire the status is still what the reader is told, which is
    // what the hand-written original shows ("Couldn't load this travel: HTTP 404").
    expect(await messageFor(runtime, new Response("", { status: 404, statusText: "Not Found" }))).toBe(
      "404 Not Found",
    );
  });
});

describe("§4.2 a malformed request body is the client's error", () => {
  it("answers 400 with a message instead of throwing on JSON.parse", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, {
      components: ["../catalog/ui", "../catalog/forms"],
      states: { loading: "Loading", error: "ErrorNotice" },
      outDir: "generated",
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    expect(result.diagnostics, JSON.stringify(result.diagnostics, null, 2)).toEqual([]);
    const mod = evaluateModule(fileOf(result.files, "handlers.ts"), (m) => {
      if (m.endsWith("/data")) return { rows: async () => [], distance: async () => 0 };
      if (m.endsWith("/actions")) return { saveTrip: async () => ({ ok: true }) };
      throw new Error(`unexpected import ${m}`);
    }) as { handlers: Record<string, (req: Request, ctx: unknown) => Promise<Response>> };

    const res = await mod.handlers["POST /_actions/saveTrip"]!(
      new Request("http://h/_actions/saveTrip", { method: "POST", body: "not json{" }),
      { params: {} },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid JSON body" });
  });

  it("answers 400 for a body that parses but is not an object", async () => {
    // §7.3: `JSON.parse("null")` succeeds, and `null as never` then failed on the
    // action's first property access — a 500 where both originals answer 400. The same
    // class as the malformed body above, and the same answer.
    const appDir = app("app-actions");
    const result = await compileApp(appDir, configFor(appDir));
    const mod = evaluateModule(fileOf(result.files, "handlers.ts"), (m) => {
      if (m.endsWith("/data")) return { rows: async () => [], distance: async () => 0 };
      if (m.endsWith("/actions")) {
        return { saveTrip: (input: { km: number }) => ({ ok: input.km > 0 }) };
      }
      throw new Error(`unexpected import ${m}`);
    }) as { handlers: Record<string, (req: Request, ctx: unknown) => Promise<Response>> };

    for (const body of ["null", "12", '"trip"', "true"]) {
      const res = await mod.handlers["POST /_actions/saveTrip"]!(
        new Request("http://h/_actions/saveTrip", { method: "POST", body }),
        { params: {} },
      );
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid JSON body" });
    }
  });

  it("still runs the action for a well-formed body", async () => {
    const appDir = app("app-actions");
    const result = await compileApp(appDir, {
      components: ["../catalog/ui", "../catalog/forms"],
      states: { loading: "Loading", error: "ErrorNotice" },
      outDir: "generated",
      tsconfigPath: join(appDir, "..", "tsconfig.strict.json"),
    });
    const seen: unknown[] = [];
    const mod = evaluateModule(fileOf(result.files, "handlers.ts"), (m) => {
      if (m.endsWith("/data")) return { rows: async () => [], distance: async () => 0 };
      if (m.endsWith("/actions")) {
        return {
          saveTrip: async (input: unknown) => {
            seen.push(input);
            return { ok: true };
          },
        };
      }
      throw new Error(`unexpected import ${m}`);
    }) as { handlers: Record<string, (req: Request, ctx: unknown) => Promise<Response>> };

    const res = await mod.handlers["POST /_actions/saveTrip"]!(
      new Request("http://h/_actions/saveTrip", { method: "POST", body: '{"km":12}' }),
      { params: {} },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ km: 12 }]);
  });
});

/**
 * A form's verdict and the field errors it was left holding, by running `useForm`'s own
 * `submit` against one canned answer. Only the state carrying `fieldErrors` is watched —
 * the other `useState` in there holds the form's values.
 */
async function submitAgainst(
  runtime: string,
  answer: unknown,
): Promise<{ verdict: boolean; errors: unknown }> {
  let errors: unknown = null;
  const stub = {
    ...React,
    useState: (init: unknown) => [
      typeof init === "function" ? (init as () => unknown)() : init,
      (next: unknown) => {
        const value = typeof next === "function" ? (next as (s: unknown) => unknown)({}) : next;
        if (value !== null && typeof value === "object" && "fieldErrors" in value) {
          errors = (value as { fieldErrors: unknown }).fieldErrors;
        }
      },
    ],
  };
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch;
  try {
    const mod = evaluateModule(runtime, (m) => {
      if (m === "react") return stub;
      throw new Error(`unexpected import ${m}`);
    }) as { useForm: (path: string, initial: object) => { submit: () => Promise<boolean> } };
    return { verdict: await mod.useForm("/_actions/saveTrip", {}).submit(), errors };
  } finally {
    globalThis.fetch = previous;
  }
}

/** Evaluate the emitted runtime against the React stub above. */
function runOneLoader(runtime: string): unknown {
  return evaluateModule(runtime, (m) => {
    if (m === "react") return React;
    throw new Error(`unexpected import ${m}`);
  });
}

/**
 * What `useLoader` would put in `state.error` for a given failed response — driven by
 * running the hook's own fetch handling, not by reading the emitted source.
 */
async function messageFor(runtime: string, response: Response): Promise<string> {
  let captured: string | null = null;
  const stub = {
    ...React,
    useState: (init: unknown) => [
      typeof init === "function" ? (init as () => unknown)() : init,
      (next: unknown) => {
        const value = typeof next === "function" ? (next as (s: unknown) => unknown)({}) : next;
        const err = (value as { error?: unknown }).error;
        if (typeof err === "string") captured = err;
      },
    ],
    // Run the effect synchronously — the server-render stub never does, and here the
    // effect is the whole point.
    useEffect: (fn: () => void) => fn(),
  };
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    const mod = evaluateModule(runtime, (m) => {
      if (m === "react") return stub;
      throw new Error(`unexpected import ${m}`);
    }) as { useLoader: (path: string, q: Record<string, string>) => unknown };
    mod.useLoader("/_data/trips", {});
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    globalThis.fetch = previous;
  }
  return captured ?? "";
}
