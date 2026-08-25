import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { HEADER, appRel, type EmittedFile } from "./types.js";

const HANDLERS_TYPE =
  "Record<string, (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>>";

/**
 * The one thing every generated handler shares: an answer that carries the status the
 * failure actually deserves.
 *
 * `respond` looks for a numeric `status` on whatever was thrown. That is the whole
 * vocabulary — a loader that wants a stale link to read as a stale link throws
 * `Object.assign(new Error("This trip no longer exists."), { status: 404 })` — and
 * anything else is re-thrown **unchanged**, so a genuine fault still reaches the host's
 * own error handling, its logging and whatever it maps a storage outage to. Turning
 * every exception into a Response here would silently take that away.
 *
 * `body` is where the status vocabulary earns itself twice: `req.json()` rejects on a
 * malformed body, which is the caller's mistake and was being reported as a server
 * error, so it is thrown as a 400 and answered by the same path. The non-object check
 * beside it is the same defect one step further on — `JSON.parse('null')` succeeds, and
 * `null` then met an action expecting an object and threw on its first property access,
 * which a host answers as a 500.
 */
const PRELUDE = [
  "/** Run a handler's body, answering with the status a thrown error asks for. */",
  "async function respond(run: () => Promise<unknown>): Promise<Response> {",
  "  try {",
  "    return Response.json(await run());",
  "  } catch (err: unknown) {",
  "    // No status is a fault this app did not describe: the host answers those.",
  "    const status = (err as { status?: unknown } | null)?.status;",
  "    if (typeof status !== 'number' || status < 400 || status > 599) throw err;",
  "    const error = err instanceof Error ? err.message : String(err);",
  "    return Response.json({ ok: false, error }, { status });",
  "  }",
  "}",
];

const PARSE_BODY = [
  "",
  "/** The request's JSON body. A body that is not JSON is the caller's 400, not a 500. */",
  "const invalidBody = () =>",
  "  Object.assign(new Error('invalid JSON body'), { status: 400 });",
  "",
  "const body = async (req: Request): Promise<unknown> => {",
  "  const value: unknown = await req.json().catch(() => {",
  "    throw invalidBody();",
  "  });",
  "  // `JSON.parse` accepts `null`, `12`, `\"x\"` and `true`; an action's input is an",
  "  // object, which is what the `as never` below asserts and nothing else checked.",
  "  if (typeof value !== 'object' || value === null) throw invalidBody();",
  "  return value;",
  "};",
];

export function emitHandlers(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER).line();
  if (app.loaders.length > 0) e.line(`import * as data from "${appRel(app, config, "data")}";`);
  if (app.actions.length > 0) e.line(`import * as actions from "${appRel(app, config, "actions")}";`);
  e.line();
  if (app.loaders.length > 0 || app.actions.length > 0) {
    e.lines(PRELUDE);
    if (app.actions.length > 0) e.lines(PARSE_BODY);
    e.line();
  }
  // One line per endpoint, so the map reads as the table of routes it is. Each entry
  // used to be a block body around a single `return`, with the search params unpacked
  // into two locals that were each read once — five lines to say "call this loader with
  // the query string", times every loader in every app.
  e.line(`export const handlers: ${HANDLERS_TYPE} = {`);
  e.indent();
  for (const name of app.loaders) {
    // A loader declared with no parameters is called with no argument — data.ts is
    // real TypeScript, and calling it with an argument it doesn't accept is a genuine
    // arity error that would otherwise surface as an unmapped "likely a nova bug"
    // diagnostic against the author's perfectly ordinary zero-input loader. It takes no
    // `req` either, and a handler that names one it cannot use needs a `void req;` to
    // get past `noUnusedParameters`; leaving the parameter out says the same thing and
    // is still assignable to the map's type.
    e.line(
      app.loaderArity[name] === 0
        ? `"GET /_data/${name}": async (): Promise<Response> => respond(() => data.${name}()),`
        : `"GET /_data/${name}": async (req: Request): Promise<Response> => respond(() => data.${name}(Object.fromEntries(new URL(req.url).searchParams.entries()) as never)),`,
    );
  }
  for (const name of app.actions) {
    e.line(
      `"POST /_actions/${name}": async (req: Request): Promise<Response> => respond(async () => actions.${name}((await body(req)) as never)),`,
    );
  }
  e.dedent();
  e.line("};");
  return { name: "handlers.ts", text: e.text(), map: e.map() };
}
