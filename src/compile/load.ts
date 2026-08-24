import { LineCounter, isNode, parseDocument } from "yaml";
import {
  diagnostic,
  type Diagnostic,
  type Position,
  type PositionMap,
} from "../schema/diagnostic.js";
import type { AppSpec } from "../schema/types.js";
import { validate } from "../schema/validate.js";

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

/**
 * Parses and validates one spec file in a single call: `loadSpecFile` builds the
 * position sidecar, `validate` checks the shape against it.
 *
 * This is the callable form of `@light/nova/schema`'s `validate`. That export takes a
 * `PositionMap`, and the only precise implementation of one is built here, from the YAML
 * document — and design §7.1 keeps the `yaml` dependency in `@light/nova/compile` so
 * that `@light/nova/schema` stays dependency-free. So the loading half lives here, and
 * this is the entry point a consumer who just wants "is this app.yaml valid, and where
 * exactly is the problem" should reach for. It runs no `ts.Program`: no catalogs are
 * read, no names are resolved and nothing is emitted, so it reports NOVA1xxx only.
 */
export function parseSpec(
  file: string,
  source: string,
): { spec: AppSpec | null; diagnostics: Diagnostic[] } {
  const { raw, positions, diagnostics } = loadSpecFile(file, source);
  if (diagnostics.length > 0) return { spec: null, diagnostics };
  return validate(raw, positions);
}
