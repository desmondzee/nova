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
 * error, so it is thrown as a 400 and answered by the same path.
 */
const PRELUDE = [
  "/** Run a handler's body, answering with the status a thrown error asks for. */",
  "async function respond(run: () => Promise<unknown>): Promise<Response> {",
  "  try {",
  "    return Response.json(await run());",
  "  } catch (err: unknown) {",
  "    // No status is not a 500 to invent here — it is a failure this app did not",
  "    // describe, and the host is what logs and answers those.",
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
  "const body = (req: Request): Promise<unknown> =>",
  "  req.json().catch(() => {",
  "    throw Object.assign(new Error('invalid JSON body'), { status: 400 });",
  "  });",
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
  e.line(`export const handlers: ${HANDLERS_TYPE} = {`);
  e.indent();
  for (const name of app.loaders) {
    e.line(`"GET /_data/${name}": async (req: Request): Promise<Response> => {`);
    e.indent();
    // A loader declared with no parameters is called with no argument — data.ts is
    // real TypeScript, and calling it with an argument it doesn't accept is a genuine
    // arity error that would otherwise surface as an unmapped "likely a nova bug"
    // diagnostic against the author's perfectly ordinary zero-input loader.
    if (app.loaderArity[name] === 0) {
      e.line("void req;");
      e.line(`return respond(() => data.${name}());`);
    } else {
      e.line("const url = new URL(req.url);");
      e.line("const input = Object.fromEntries(url.searchParams.entries());");
      e.line(`return respond(() => data.${name}(input as never));`);
    }
    e.dedent();
    e.line("},");
  }
  for (const name of app.actions) {
    e.line(`"POST /_actions/${name}": async (req: Request): Promise<Response> => {`);
    e.indent();
    e.line(`return respond(async () => actions.${name}((await body(req)) as never));`);
    e.dedent();
    e.line("},");
  }
  e.dedent();
  e.line("};");
  return { name: "handlers.ts", text: e.text(), map: e.map() };
}
