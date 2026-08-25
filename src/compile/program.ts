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
  /**
   * Property names of the first parameter's type, when that type is an object with a
   * known, closed set of them — `null` otherwise (a primitive parameter, a type with a
   * string index signature, an export with no parameters, or an export nobody asked
   * about).
   *
   * Read for one reason: a loader is called with an input object nova assembles, and
   * assembling it from *everything* the page has means a loader declaring `{ region }`
   * is re-requested when an unrelated filter moves and a loader declaring nothing at all
   * is re-requested on every keystroke. The loader's own signature is the statement of
   * what it depends on; this is how the emitter reads it.
   */
  paramKeys: string[] | null;
  /**
   * Type parameters of the first call signature: how many there are, and how many carry
   * no default (so must be written if a type argument list is written at all).
   *
   * Read for one reason: a generic component invoked with no type argument resolves its
   * parameter by inference, and a parameter no supplied prop mentions falls back to
   * something that makes every constraint derived from it vacuous — a picker declaring
   * `key: BooleanKeys<T>` accepts any string at all. `total > 0` is what tells the
   * emitter to write the type argument it knows (see emitField).
   */
  typeParams: { total: number; required: number };
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

/**
 * The property names of a call signature's first parameter, or null where there is no
 * closed set of them to name.
 *
 * A string index signature means the type accepts keys nobody declared, so narrowing an
 * assembled input object to the declared ones would silently drop values the callee can
 * legitimately read — `null` keeps the caller's existing behaviour there. A parameter
 * that is a primitive, a union, or generic likewise yields nothing to narrow by.
 */
function firstParamKeys(checker: ts.TypeChecker, signature: ts.Signature): string[] | null {
  const parameter = signature.parameters[0];
  if (!parameter) return null;
  const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
  if (!declaration) return null;
  const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
  if (type.isUnionOrIntersection() || type.flags & ts.TypeFlags.TypeParameter) return null;
  if (checker.getIndexInfoOfType(type, ts.IndexKind.String) !== undefined) return null;
  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) return null;
  return properties.map((p) => p.getName()).sort();
}

/**
 * @param opts.signatures - Read the first parameter's property names too. Off by
 * default: only `data.ts` needs it, and asking for it would make every catalog export's
 * props type resolve on a host catalog of hundreds of components for nothing.
 */
export function moduleExports(
  program: ts.Program,
  file: string,
  opts: { signatures?: boolean } = {},
): ExportInfo[] {
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
    const typeParams = callSignatures[0]?.declaration?.typeParameters;
    out.push({
      name: symbol.getName(),
      callable: callSignatures.length > 0,
      file: decl.fileName,
      line: line + 1,
      col: character + 1,
      paramCount: callSignatures[0]?.parameters.length ?? 0,
      paramKeys:
        opts.signatures && callSignatures[0]
          ? firstParamKeys(checker, callSignatures[0])
          : null,
      typeParams: {
        total: typeParams?.length ?? 0,
        required:
          typeParams?.filter((p) => !ts.isTypeParameterDeclaration(p) || p.default === undefined)
            .length ?? 0,
      },
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
