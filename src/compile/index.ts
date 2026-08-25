import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { diagnostic, type Diagnostic } from "../schema/diagnostic.js";
import { validate } from "../schema/validate.js";
import { readCatalogs } from "./catalog.js";
import { validateConfig, type NovaConfig } from "./config.js";
import {
  emitContract,
  emitHandlers,
  emitPages,
  emitRuntime,
  emitTypes,
  emitViews,
  type EmittedFile,
} from "./emit/index.js";
import { loadSpecFile } from "./load.js";
import { typescriptDefect, type ProgramSession } from "./program.js";
import { resolveApp } from "./resolve.js";
import { typecheckEmitted } from "./typecheck.js";

export type { NovaConfig } from "./config.js";
export { loadSpecFile, parseSpec } from "./load.js";
export type { AppSpec } from "../schema/types.js";
export type { EmittedFile, LineMap } from "./emit/index.js";
export { createSession, type ProgramSession } from "./program.js";
// Every type reachable through a `./compile` signature is nameable from `./compile`:
// `EmittedFile.map` is a `LineMap`, which is `Map<number, SpecPath>`; `Diagnostic`
// carries a `Severity` and an optional `Related[]`, and `Related` extends `Position`.
// A consumer writing a helper over any of those must not have to reach into `./schema`
// or resort to indexed-access gymnastics to spell the type out.
export type {
  Diagnostic,
  Position,
  PositionMap,
  Related,
  Severity,
  SpecPath,
} from "../schema/diagnostic.js";

export type CompileResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  files: EmittedFile[];
  written: string[];
};

const VERSION = "0.2.0";

/**
 * Deterministic JSON: object keys are sorted recursively so two `NovaConfig` values
 * with the same content but different key insertion order still stringify identically.
 * Array order is preserved as given (array order matters, e.g. `components` order can
 * affect diagnostics ordering — see resolve.ts — so it is not sorted here).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const fail = (diagnostics: Diagnostic[]): CompileResult => ({
  ok: false,
  diagnostics,
  files: [],
  written: [],
});

/**
 * Compiles one app end to end: load → validate → catalogs → resolve → emit → write →
 * typecheck. Each stage stops the pipeline as soon as it produces an error diagnostic,
 * so (for example) a missing `sections` key never cascades into fifty downstream type
 * errors from `typecheckEmitted`.
 *
 * @param appDirArg - The app folder. Relative or absolute; it is resolved against the
 * process working directory once, here, and everything downstream — the spec file, the
 * output directory, every emitted import specifier and every diagnostic's `file` — is
 * absolute from that point on.
 *
 * @param opts.write - Defaults to `true`. When `false`, the whole pipeline still runs
 * in memory and `result.files` is still populated, but nothing is written to disk and
 * `typecheckEmitted` is skipped entirely — there is nothing on disk yet for TypeScript
 * to check. This is what a `--check`/preview mode uses to see what would be emitted.
 * Consequently, `result.ok === true` under `write: false` means only "the spec resolved
 * and emitted successfully" — it does NOT mean the emitted output type-checks. Only a
 * `write: true` run (the default) verifies that.
 *
 * @param opts.session - Optional. TypeScript work to share with other `compileApp`
 * calls: parsed tsconfigs, and parsed source files (the lib files, `@types/*` and the
 * host component catalog are the same for every app). Without one, each call parses all
 * of that again from scratch. A build script compiling many apps should create one with
 * `createSession()` and pass it to every call; results are identical either way.
 */
export async function compileApp(
  appDirArg: string,
  config: NovaConfig,
  opts: { write?: boolean; session?: ProgramSession } = {},
): Promise<CompileResult> {
  const write = opts.write ?? true;
  // Resolved here, once, and never used relative again. TypeScript reports every
  // `SourceFile.fileName` as an absolute path, so a relative appDir made
  // `typecheckEmitted`'s file map miss every entry and silently discard every
  // NOVA3001/NOVA3002 — a compiler answering `ok: true` on output that does not
  // compile. The README's own example passed a relative path, so that was the
  // documented way to use it.
  // Before anything reads the arguments: an appDir that is not a string is the one way
  // to make `resolve` itself throw, and there is no position to report a diagnostic at
  // until it has been resolved.
  if (typeof appDirArg !== "string" || appDirArg === "") {
    return fail([
      diagnostic(
        "NOVA2014",
        `the app folder is ${typeof appDirArg === "string" ? "empty" : typeof appDirArg}, not a path`,
        { file: "nova.config", line: 1, col: 1 },
      ),
    ]);
  }
  const appDir = resolve(appDirArg);
  const specFile = join(appDir, "app.yaml");

  // Both of these are about the toolchain rather than the app, and both are cheap, so
  // they are answered before a byte of the spec is read: a run that cannot possibly
  // succeed should say why in its own terms, not fail later inside somebody else's.
  const defect = typescriptDefect();
  if (defect !== null) {
    return fail([
      diagnostic("NOVA2013", defect, { file: specFile, line: 1, col: 1 }, {
        hint: "nova supports typescript >=5.5 <7; install one alongside it",
      }),
    ]);
  }
  const configDiags = validateConfig(config, { file: specFile, line: 1, col: 1 });
  if (configDiags.length > 0) return fail(configDiags);

  if (!existsSync(specFile)) {
    return fail([
      diagnostic("NOVA1006", "no app.yaml in this app folder", { file: specFile, line: 1, col: 1 }),
    ]);
  }

  const isError = (d: Diagnostic) => d.severity === "error";

  const source = readFileSync(specFile, "utf8");
  const { raw, positions, diagnostics: loadDiags } = loadSpecFile(specFile, source);
  if (loadDiags.some(isError)) return fail(loadDiags);

  const { spec, diagnostics: validateDiags } = validate(raw, positions);
  if (!spec) return fail(validateDiags);

  const { catalog, diagnostics: catalogDiags } = readCatalogs(config, specFile, opts.session);
  if (catalogDiags.some(isError)) return fail([...validateDiags, ...catalogDiags]);

  const { resolved, diagnostics: resolveDiags } = resolveApp(spec, {
    config,
    appDir,
    specFile,
    catalog,
    positions,
    session: opts.session,
  });
  if (!resolved) return fail([...validateDiags, ...resolveDiags]);

  // Covers the spec source, the whole nova.config (so a change to states, outDir,
  // importExtension or tsconfigPath — all of which affect emitted output — changes the
  // stamp too) and the compiler version. It does NOT cover the contents of data.ts,
  // actions.ts, compute.ts, or any catalog/local component file, so it is not yet
  // sufficient on its own to safely skip work when only those change.
  const hash = createHash("sha256")
    .update(source)
    .update("\n")
    .update(stableStringify(config))
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
    emitViews(resolved, config),
    emitPages(resolved, config),
    emitHandlers(resolved, config),
    emitContract(resolved, config),
  ]
    .map(stamp)
    .sort((a, b) => a.name.localeCompare(b.name));

  const outDir = resolve(appDir, config.outDir);
  const written: string[] = [];
  if (write) {
    mkdirSync(outDir, { recursive: true });
    for (const f of files) {
      const path = join(outDir, f.name);
      writeFileSync(path, f.text);
      written.push(path);
    }
  }

  // Skipped under write: false — nothing was written to disk for TypeScript to check.
  const typeDiags = write
    ? typecheckEmitted({
        files,
        outDir,
        tsconfigPath: config.tsconfigPath,
        positions,
        session: opts.session,
      })
    : [];

  const diagnostics = [...validateDiags, ...resolveDiags, ...typeDiags];
  return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics, files, written };
}
