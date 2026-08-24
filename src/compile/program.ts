import { dirname } from "node:path";
import ts from "typescript";

export type ExportInfo = {
  name: string;
  callable: boolean;
  file: string;
  line: number;
  col: number;
  /** Parameter count of the first call signature, or 0 when the export isn't callable. */
  paramCount: number;
};

/**
 * Return type of `createProgram`. Exported because `declaration: true` needs the name;
 * it carries only the program — a `checker` field used to be built eagerly here on
 * every call and read by nobody, since `moduleExports` gets its own from the program.
 */
export type ProgramHandle = { program: ts.Program };

type Stamp = string;
type CachedFile = { stamp: Stamp; file: ts.SourceFile | undefined };
type CachedConfig = { stamp: Stamp; parsed: ts.ParsedCommandLine | null };

/**
 * Work shared by every `ts.Program` built through one session: parsed tsconfigs and
 * parsed (and, once a checker has touched them, bound) `ts.SourceFile`s. Pass one
 * session to every `compileApp` call of a build and the lib files, `@types/*` and host
 * catalog are parsed once instead of once per program — which is where nearly all of a
 * multi-app build's time used to go.
 *
 * Treat it as opaque apart from `programs`. Every cache entry is validated against the
 * file's modification time and size on each lookup, so a file edited between calls (the
 * watch-mode case) is re-read; a session is safe to keep alive across rebuilds. The one
 * thing it does not notice is a *new* file appearing under the tsconfig's `include`
 * without the tsconfig itself changing — start a fresh session if that matters.
 *
 * Reusing bound source files across programs is what TypeScript's own document registry
 * does for every editor; it is sound as long as the compiler options are identical,
 * which is why cache keys are scoped by tsconfig path.
 */
export type ProgramSession = {
  /**
   * How many `ts.Program`s this session has created. A build that shares a session
   * should create a handful, not one set per app — `test/program.test.ts` pins this.
   */
  programs: number;
  /** @internal keyed by tsconfig path */
  configs: Map<string, CachedConfig>;
  /** @internal keyed by tsconfig path, then by file name */
  files: Map<string, Map<string, CachedFile>>;
};

export function createSession(): ProgramSession {
  return { programs: 0, configs: new Map(), files: new Map() };
}

function stampOf(path: string): Stamp {
  const mtime = ts.sys.getModifiedTime?.(path);
  return `${mtime === undefined ? -1 : mtime.getTime()}:${ts.sys.getFileSize?.(path) ?? -1}`;
}

function readConfig(tsconfigPath: string, session: ProgramSession): ts.ParsedCommandLine | null {
  const stamp = stampOf(tsconfigPath);
  const hit = session.configs.get(tsconfigPath);
  if (hit && hit.stamp === stamp) return hit.parsed;
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed =
    read.error || !read.config
      ? null
      : ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
  session.configs.set(tsconfigPath, { stamp, parsed });
  return parsed;
}

/**
 * Ambient declarations — globals, JSX types, module augmentations — take effect only if
 * they are in the program, and nothing imports them, so they have to come in as roots.
 * Everything else in a tsconfig's `include` is reachable by import from the roots that
 * actually matter, and TypeScript follows imports itself.
 */
const isAmbient = (file: string) => /\.d\.(c|m)?ts$/.test(file);

/** A compiler host that answers `getSourceFile` from the session's cache. */
function hostFor(
  session: ProgramSession,
  tsconfigPath: string,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const parse = host.getSourceFile.bind(host);
  let cache = session.files.get(tsconfigPath);
  if (!cache) session.files.set(tsconfigPath, (cache = new Map()));
  const files = cache;
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    if (shouldCreate) return parse(fileName, languageVersionOrOptions, onError, shouldCreate);
    const stamp = stampOf(fileName);
    const hit = files.get(fileName);
    if (hit && hit.stamp === stamp) return hit.file;
    const file = parse(fileName, languageVersionOrOptions, onError, shouldCreate);
    files.set(fileName, { stamp, file });
    return file;
  };
  return host;
}

export function createProgram(opts: {
  tsconfigPath: string;
  roots: string[];
  /** Reuse parsed tsconfigs and source files across calls. One is created per call if omitted. */
  session?: ProgramSession;
}): ProgramHandle | null {
  if (!ts.sys.fileExists(opts.tsconfigPath)) return null;
  const session = opts.session ?? createSession();
  const parsed = readConfig(opts.tsconfigPath, session);
  if (!parsed) return null;
  // Only the ambient files from `include`. Unioning in the whole `include` set —
  // an entire repository on a host tsconfig — made every call parse thousands of
  // files that no root reaches.
  const rootNames = [...new Set([...parsed.fileNames.filter(isAmbient), ...opts.roots])].sort();
  session.programs++;
  return {
    program: ts.createProgram({
      rootNames,
      options: parsed.options,
      host: hostFor(session, opts.tsconfigPath, parsed.options),
    }),
  };
}

export function moduleExports(program: ts.Program, file: string): ExportInfo[] {
  const source = program.getSourceFile(file);
  if (!source) return [];
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return [];

  const out: ExportInfo[] = [];
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const declaration = symbol.declarations?.[0];
    if (!declaration) continue;
    const decl = declaration.getSourceFile();
    const { line, character } = decl.getLineAndCharacterOfPosition(declaration.getStart());
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const callSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    out.push({
      name: symbol.getName(),
      callable: callSignatures.length > 0,
      file: decl.fileName,
      line: line + 1,
      col: character + 1,
      paramCount: callSignatures[0]?.parameters.length ?? 0,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function resolveModule(
  specifier: string,
  containingFile: string,
  tsconfigPath: string,
  session?: ProgramSession,
): string | null {
  const parsed = readConfig(tsconfigPath, session ?? createSession());
  if (!parsed) return null;
  const resolved = ts.resolveModuleName(specifier, containingFile, parsed.options, ts.sys);
  return resolved.resolvedModule?.resolvedFileName ?? null;
}
