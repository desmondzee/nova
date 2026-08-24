import { LineCounter, isNode, parseDocument } from "yaml";
import {
  diagnostic,
  type Diagnostic,
  type Position,
  type PositionMap,
} from "../schema/diagnostic.js";

export type { PositionMap } from "../schema/diagnostic.js";

export function loadSpecFile(
  file: string,
  source: string,
): { raw: unknown; positions: PositionMap; diagnostics: Diagnostic[] } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });

  const start: Position = { file, line: 1, col: 1 };
  const posOf = (offset: number): Position => {
    const { line, col } = lineCounter.linePos(offset);
    return { file, line, col };
  };

  const positions: PositionMap = {
    at(path) {
      for (let i = path.length; i >= 0; i--) {
        const node = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
        // Every collection node (map/seq) also satisfies isNode, which short-circuits
        // first — a dedicated isCollection(node) branch below this one is unreachable
        // (confirmed against yaml@2.9.0).
        if (isNode(node) && node.range) return posOf(node.range[0]);
      }
      return start;
    },
  };

  const diagnostics = doc.errors.map((e) => diagnostic("NOVA1000", e.message, posOf(e.pos[0])));

  return { raw: diagnostics.length > 0 ? null : doc.toJS(), positions, diagnostics };
}
