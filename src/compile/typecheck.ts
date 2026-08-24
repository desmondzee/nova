import { join } from "node:path";
import ts from "typescript";
import { diagnostic, type Diagnostic } from "../schema/diagnostic.js";
import type { EmittedFile } from "./emit/types.js";
import type { PositionMap } from "./load.js";
import { createProgram, type ProgramSession } from "./program.js";

/**
 * Runs TypeScript over the emitted output and remaps anything it reports back to the
 * spec line that produced it.
 *
 * Scope: only diagnostics on files listed in `opts.files` are reported. TypeScript's
 * program may pull in other files while resolving imports — the author's own
 * hand-written `data.ts`/`actions.ts`, or a host catalog component — and diagnostics on
 * those are deliberately dropped. That code already goes through the author's own
 * `tsc`, editor, and CI; duplicating it here would just be noise. The spec-to-code seam
 * itself stays covered because `pages.tsx`'s JSX binds every spec prop to the component
 * and loader/action types it references — real React JSX typing, not a comparator nova
 * maintains — and is always one of the emitted files. `__contract.ts` is a narrower,
 * additional check: `XxxInput`/`Xxx` are themselves derived from the loader/action they
 * are then assigned back to (`Parameters<typeof data.x>[0]`,
 * `Awaited<ReturnType<typeof data.x>>`), so it cannot catch a prop/loader type
 * mismatch — pages.tsx already does — but it does catch loader arity and a loader that
 * isn't async, which pages.tsx's JSX has no occasion to exercise.
 *
 * Consequently, an empty result means the seam between the spec and the author's code
 * is clean — it does NOT mean the overall build is clean.
 *
 * Both syntactic and semantic diagnostics are collected and treated identically: a
 * diagnostic on a generated line with a spec origin becomes `NOVA3001` at that spec
 * position; one with no origin keeps the generated location under `NOVA3002`. This
 * covers not just type errors but malformed output — an unbalanced brace, a bad
 * template edge case, an unescaped quote from a spec string literal — since TypeScript
 * reporting a problem in emitted output is exactly what both codes mean.
 */
export function typecheckEmitted(opts: {
  files: EmittedFile[];
  outDir: string;
  tsconfigPath: string;
  positions: PositionMap;
  session?: ProgramSession;
}): Diagnostic[] {
  const paths = opts.files.map((f) => join(opts.outDir, f.name));
  const handle = createProgram({
    tsconfigPath: opts.tsconfigPath,
    roots: paths,
    session: opts.session,
  });
  if (!handle) return [];

  const mapByPath = new Map(opts.files.map((f, i) => [paths[i]!, f.map]));
  const out: Diagnostic[] = [];

  // Asked per emitted file rather than for the whole program. Everything a whole-program
  // request adds is a diagnostic on a file `mapByPath` does not know — the author's own
  // `data.ts`, a catalog component, a global option error — and the loop below drops
  // every one of those anyway. Same files asked, same answers, without checking a
  // repository's worth of code that is never reported on.
  const diagnostics = handle.program.getSourceFiles().flatMap((file) =>
    mapByPath.has(file.fileName)
      ? [
          ...handle.program.getSyntacticDiagnostics(file),
          ...handle.program.getSemanticDiagnostics(file),
        ]
      : [],
  );

  for (const d of diagnostics) {
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
