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

function readConfig(tsconfigPath: string): ts.ParsedCommandLine | null {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error || !read.config) return null;
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
}

export function createProgram(opts: {
  tsconfigPath: string;
  roots: string[];
}): ProgramHandle | null {
  if (!ts.sys.fileExists(opts.tsconfigPath)) return null;
  const parsed = readConfig(opts.tsconfigPath);
  if (!parsed) return null;
  const rootNames = [...new Set([...parsed.fileNames, ...opts.roots])].sort();
  return { program: ts.createProgram({ rootNames, options: parsed.options }) };
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
): string | null {
  const parsed = readConfig(tsconfigPath);
  if (!parsed) return null;
  const resolved = ts.resolveModuleName(specifier, containingFile, parsed.options, ts.sys);
  return resolved.resolvedModule?.resolvedFileName ?? null;
}
