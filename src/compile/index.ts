import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagnostic, type Diagnostic } from "../schema/diagnostic.js";
import { validate } from "../schema/validate.js";
import { readCatalogs } from "./catalog.js";
import type { NovaConfig } from "./config.js";
import {
  emitContract,
  emitHandlers,
  emitPages,
  emitRuntime,
  emitTypes,
  type EmittedFile,
} from "./emit/index.js";
import { loadSpecFile } from "./load.js";
import { resolveApp } from "./resolve.js";
import { typecheckEmitted } from "./typecheck.js";

export type { NovaConfig } from "./config.js";
export type { EmittedFile } from "./emit/index.js";
export type { Diagnostic } from "../schema/diagnostic.js";

export type CompileResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  files: EmittedFile[];
  written: string[];
};

const VERSION = "0.0.0";

const fail = (diagnostics: Diagnostic[]): CompileResult => ({
  ok: false,
  diagnostics,
  files: [],
  written: [],
});

export async function compileApp(
  appDir: string,
  config: NovaConfig,
  opts: { write?: boolean } = {},
): Promise<CompileResult> {
  const write = opts.write ?? true;
  const specFile = join(appDir, "app.yaml");
  if (!existsSync(specFile)) {
    return fail([
      diagnostic("NOVA1006", "no app.yaml in this app folder", { file: specFile, line: 1, col: 1 }),
    ]);
  }

  const source = readFileSync(specFile, "utf8");
  const { raw, positions, diagnostics: loadDiags } = loadSpecFile(specFile, source);
  if (loadDiags.length > 0) return fail(loadDiags);

  const { spec, diagnostics: validateDiags } = validate(raw, positions);
  if (!spec) return fail(validateDiags);

  const { catalog, diagnostics: catalogDiags } = readCatalogs(config, specFile);
  if (catalogDiags.length > 0) return fail([...validateDiags, ...catalogDiags]);

  const { resolved, diagnostics: resolveDiags } = resolveApp(spec, {
    config,
    appDir,
    specFile,
    catalog,
    positions,
  });
  if (!resolved) return fail([...validateDiags, ...resolveDiags]);

  const hash = createHash("sha256")
    .update(source)
    .update("\n")
    .update([...config.components].sort().join("\n"))
    .update("\n")
    .update(VERSION)
    .digest("hex")
    .slice(0, 16);

  const stamp = (f: EmittedFile): EmittedFile => {
    const [first, ...rest] = f.text.split("\n");
    return { ...f, text: [`${first} inputs:${hash}`, ...rest].join("\n") };
  };

  const files = [
    emitTypes(resolved, config),
    emitRuntime(resolved, config),
    emitPages(resolved, config),
    emitHandlers(resolved, config),
    emitContract(resolved, config),
  ]
    .map(stamp)
    .sort((a, b) => a.name.localeCompare(b.name));

  const outDir = join(appDir, config.outDir);
  const written: string[] = [];
  if (write) {
    mkdirSync(outDir, { recursive: true });
    for (const f of files) {
      const path = join(outDir, f.name);
      writeFileSync(path, f.text);
      written.push(path);
    }
  }

  const typeDiags = write
    ? typecheckEmitted({ files, outDir, tsconfigPath: config.tsconfigPath, positions })
    : [];

  const diagnostics = [...validateDiags, ...resolveDiags, ...typeDiags];
  return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics, files, written };
}
