export type Severity = "error" | "warning";

export type Position = { file: string; line: number; col: number };

export type Related = Position & { message: string };

/**
 * A path into the spec document, e.g. ["pages", "/", "sections", 1, "rows"].
 *
 * Declared here — next to `PositionMap`, the one thing that consumes it — rather than
 * once per layer. `resolve.ts` (spec origins) and `emit/emitter.ts` (the line map) both
 * import it, so the package has one publicly-named spelling of the concept instead of
 * three structurally identical ones.
 */
export type SpecPath = (string | number)[];

/** Resolves a path within the spec document to a source position. */
export type PositionMap = { at(path: SpecPath): Position };

/**
 * A `PositionMap` that resolves every path to the top of `file`.
 *
 * `validate` needs positions, and the only precise implementation is built by
 * `loadSpecFile`, which lives in `@desmondzee/nova/compile` because it owns the YAML
 * dependency (design §7.1 keeps `@desmondzee/nova/schema` dependency-free). This is the
 * dependency-free fallback: a consumer that has already parsed a document by some other
 * route can call `validate(raw, atFile("app.yaml"))` and get every diagnostic, with the
 * file right and the line/column pinned at 1:1. Use `parseSpec` from
 * `@desmondzee/nova/compile` when precise positions matter.
 */
export function atFile(file: string): PositionMap {
  const position: Position = { file, line: 1, col: 1 };
  return { at: () => position };
}

export type Diagnostic = {
  code: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  col: number;
  hint?: string;
  related?: Related[];
};

export function diagnostic(
  code: string,
  message: string,
  at: Position,
  opts: { severity?: Severity; hint?: string; related?: Related[] } = {},
): Diagnostic {
  const d: Diagnostic = {
    code,
    severity: opts.severity ?? "error",
    message,
    file: at.file,
    line: at.line,
    col: at.col,
  };
  if (opts.hint !== undefined) d.hint = opts.hint;
  if (opts.related !== undefined && opts.related.length > 0) d.related = opts.related;
  return d;
}

/** Levenshtein distance, capped — we only care about "near". */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[cols - 1]!;
}

/**
 * The closest candidate, when one is close enough to be worth suggesting.
 * Threshold scales with length so short names do not match everything.
 */
export function suggest(name: string, candidates: string[]): string | undefined {
  const limit = name.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestScore = Infinity;
  // Sort candidates so ties (equal distance) resolve deterministically, alphabetically-first.
  for (const c of [...candidates].sort()) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d <= limit && d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best;
}
