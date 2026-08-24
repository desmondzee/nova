import { join } from "node:path";
import ts from "typescript";
import { diagnostic, type Diagnostic } from "../schema/diagnostic.js";
import type { EmittedFile } from "./emit/types.js";
import type { PositionMap } from "./load.js";
import { createProgram } from "./program.js";

export function typecheckEmitted(opts: {
  files: EmittedFile[];
  outDir: string;
  tsconfigPath: string;
  positions: PositionMap;
}): Diagnostic[] {
  const paths = opts.files.map((f) => join(opts.outDir, f.name));
  const handle = createProgram({ tsconfigPath: opts.tsconfigPath, roots: paths });
  if (!handle) return [];

  const mapByPath = new Map(opts.files.map((f, i) => [paths[i]!, f.map]));
  const out: Diagnostic[] = [];

  for (const d of handle.program.getSemanticDiagnostics()) {
    if (!d.file || d.start === undefined) continue;
    const map = mapByPath.get(d.file.fileName);
    if (!map) continue;

    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    const generatedLine = line + 1;
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const related = [
      {
        file: d.file.fileName,
        line: generatedLine,
        col: character + 1,
        message: "in generated output",
      },
    ];

    const origin = map.get(generatedLine);
    if (origin) {
      out.push(diagnostic("NOVA3001", message, opts.positions.at(origin), { related }));
    } else {
      out.push(
        diagnostic(
          "NOVA3002",
          message,
          { file: d.file.fileName, line: generatedLine, col: character + 1 },
          { hint: "this generated line has no spec origin — likely a nova bug" },
        ),
      );
    }
  }

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
}
