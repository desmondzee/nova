import { dirname } from "node:path";
import ts from "typescript";

/**
 * The `typescript` entry points nova calls. Everything else it touches is a type, and
 * types are erased — these are the whole of the runtime surface, so this list is what
 * "a TypeScript nova can drive" means.
 */
const REQUIRED_API = [
  "createCompilerHost",
  "createProgram",
  "flattenDiagnosticMessageText",
  "isTypeParameterDeclaration",
  "parseJsonConfigFileContent",
  "readConfigFile",
  "resolveModuleName",
  "sys",
] as const;

/**
 * Which of `REQUIRED_API` the given `typescript` namespace does not provide.
 *
 * Nova's peer range is `>=5.5 <7`, but a range only constrains what a package manager
 * installs — it cannot constrain what is already in a host's `node_modules`, or what a
 * host resolves through an alias, a workspace link or a bundled copy. TypeScript 7's
 * main entry exports `version` and `versionMajorMinor` and nothing else (the compiler
 * API moved), so an unguarded nova met it as `TypeError: Cannot read properties of
 * undefined (reading 'fileExists')` thrown from inside nova's own `node_modules` —
 * which reads as nova being broken rather than as nova being paired with a TypeScript
 * it does not support.
 *
 * Kept as a pure function over an arbitrary namespace object so the unsupported case is
 * testable without installing an unsupported TypeScript.
 */
export function missingCompilerApi(api: unknown): string[] {
  if (typeof api !== "object" || api === null) return [...REQUIRED_API];
  const record = api as Record<string, unknown>;
  return REQUIRED_API.filter((name) =>
    name === "sys"
      ? typeof record["sys"] !== "object" || record["sys"] === null
      : typeof record[name] !== "function",
  );
}

/**
 * A sentence naming what is wrong with the resolved TypeScript, or `null` when it is
 * one nova can drive. Reported by `compileApp` as `NOVA2013` rather than thrown: a host
 * that prints diagnostics should be told this the same way it is told about an
 * unreadable tsconfig, and the answer is the same shape — fix the toolchain, not the
 * spec.
 */
export function typescriptDefect(): string | null {
  const missing = missingCompilerApi(ts);
  if (missing.length === 0) return null;
  const version = typeof ts?.version === "string" ? ts.version : "unknown";
  return `the resolved 'typescript' (${version}) does not provide the compiler API nova needs (missing: ${missing.join(", ")})`;
}

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
   * The subset of `paramKeys` whose declared type cannot be a string at all.
   *
   * A generated loader handler calls `data.x(Object.fromEntries(searchParams) as never)`
   * — every value it can ever pass is a `string`, because a query string holds nothing
   * else. A key declared `limit: number` is therefore receiving `"25"`, and `input.limit
   * > 10` compares a string to a number with nothing anywhere saying so. Nova already
   * has the type; reporting it is one diagnostic instead of a silent falsehood.
   *
   * A type that *can* be a string is left alone, including a union that merely narrows
   * it: `dir: "asc" | "desc"` is how the README's own sorting section says to declare
   * the sort direction, and nova is the one writing that parameter.
   */
  paramKeysNeverString: string[];
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
function firstParamKeys(
  checker: ts.TypeChecker,
  signature: ts.Signature,
): { keys: string[]; neverString: string[] } | null {
  const parameter = signature.parameters[0];
  if (!parameter) return null;
  const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
  if (!declaration) return null;
  const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
  if (type.isUnionOrIntersection() || type.flags & ts.TypeFlags.TypeParameter) return null;
  if (checker.getIndexInfoOfType(type, ts.IndexKind.String) !== undefined) return null;
  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) return null;
  const neverString = properties
    .filter((p) => {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      if (!decl) return false;
      return !canBeString(checker.getTypeOfSymbolAtLocation(p, decl));
    })
    .map((p) => p.getName())
    .sort();
  return { keys: properties.map((p) => p.getName()).sort(), neverString };
}

/**
 * Whether a string is one of the things this type can hold.
 *
 * Deliberately permissive: `any`, `unknown` and every string flavour pass, a union
 * passes if any constituent does, and only a type with no string-shaped constituent at
 * all — `number`, `boolean`, `Date`, an object, `number | undefined` — is reported. An
 * intersection is left alone; narrowing a string by intersection is unusual enough that
 * guessing wrong there would be worse than saying nothing.
 */
function canBeString(type: ts.Type): boolean {
  const STRINGY =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.String |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.TemplateLiteral |
    ts.TypeFlags.StringMapping |
    ts.TypeFlags.TypeParameter;
  if (type.flags & STRINGY) return true;
  if (type.isUnion()) return type.types.some(canBeString);
  if (type.isIntersection()) return true;
  return false;
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
  const NO_PARAM_KEYS = { keys: null, neverString: [] as string[] };
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const declaration = symbol.declarations?.[0];
    if (!declaration) continue;
    const decl = declaration.getSourceFile();
    const { line, character } = decl.getLineAndCharacterOfPosition(declaration.getStart());
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const callSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    const typeParams = callSignatures[0]?.declaration?.typeParameters;
    const params =
      (opts.signatures && callSignatures[0] ? firstParamKeys(checker, callSignatures[0]) : null) ??
      NO_PARAM_KEYS;
    out.push({
      name: symbol.getName(),
      callable: callSignatures.length > 0,
      file: decl.fileName,
      line: line + 1,
      col: character + 1,
      paramCount: callSignatures[0]?.parameters.length ?? 0,
      paramKeys: params.keys,
      paramKeysNeverString: params.neverString,
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
