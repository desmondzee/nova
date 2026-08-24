import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { HEADER, appRel, type EmittedFile } from "./types.js";

const HANDLERS_TYPE =
  "Record<string, (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>>";

export function emitHandlers(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER).line();
  if (app.loaders.length > 0) e.line(`import * as data from "${appRel(config, "data")}";`);
  if (app.actions.length > 0) e.line(`import * as actions from "${appRel(config, "actions")}";`);
  e.line();
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
      e.line(`return Response.json(await data.${name}());`);
    } else {
      e.line("const url = new URL(req.url);");
      e.line("const input = Object.fromEntries(url.searchParams.entries());");
      e.line(`return Response.json(await data.${name}(input as never));`);
    }
    e.dedent();
    e.line("},");
  }
  for (const name of app.actions) {
    e.line(`"POST /_actions/${name}": async (req: Request): Promise<Response> => {`);
    e.indent();
    e.line(`return Response.json(await actions.${name}((await req.json()) as never));`);
    e.dedent();
    e.line("},");
  }
  e.dedent();
  e.line("};");
  return { name: "handlers.ts", text: e.text(), map: e.map() };
}
