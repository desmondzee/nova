# Nova UI Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@light/nova`, a build-time compiler that turns a declarative YAML description of an app's UI into React pages and HTTP handlers, with every type check performed by the host's own TypeScript.

**Architecture:** Two entry points, no shipped runtime. `@light/nova/schema` holds the spec types and a position-aware validator. `@light/nova/compile` loads YAML with source positions, introspects the host's component catalogs and the app's own `data.ts` / `actions.ts` via the TypeScript compiler API, emits a `generated/` folder, then typechecks the emitted output and remaps every diagnostic back to the YAML line that caused it. Generated code imports only the host's catalogs, the app's own files, and React — never nova.

**Tech Stack:** TypeScript 5.7, Node ≥20, pnpm, vitest, the `yaml` package (position-aware parsing), and the TypeScript compiler API as a peer dependency.

**Spec:** [`docs/superpowers/specs/2026-08-24-nova-ui-compiler-design.md`](../specs/2026-08-24-nova-ui-compiler-design.md)

## Global Constraints

- **Package name:** `@light/nova`. Version starts at `0.0.0`.
- **No root export.** `package.json` `exports` has no `"."` key — only `./schema` and `./compile`. This is load-bearing (spec §7.3); never add one.
- **ESM only.** `"type": "module"`, `module`/`moduleResolution` are `nodenext`. **Every relative import in `src/` and `test/` must carry a `.js` extension**, even when importing a `.ts` file. `import { x } from "./foo.js"` resolves `./foo.ts`.
- **`typescript` is a `peerDependency`** at `>=5.5`, and a `devDependency` at `^5.7.2`. Never promote it to a regular dependency.
- **No host knowledge.** No Light types, URLs, `@platform/*` imports, or framework names anywhere in `src/`. Tests compile against `test/fixtures/catalog/`, which has no relationship to Light.
- **Generated output imports nothing from nova.** Only catalog modules, the app's own relative files, and `react`.
- **Diagnostic codes are stable.** Once a `NOVAnnnn` code ships, its meaning never changes. Tests assert on codes, never on message wording.
- **Emission is byte-deterministic.** Same inputs produce identical bytes; no timestamps, no iteration over unsorted maps.
- **Node engines:** `>=20`.

---

## File Structure

```
nova/
├── package.json                     name, exports map, peer/dev deps, scripts
├── tsconfig.json                    typecheck config (src + test, noEmit)
├── tsconfig.build.json              emit config (src only → dist)
├── vitest.config.ts                 test runner config
├── src/
│   ├── schema/
│   │   ├── index.ts                 public surface of @light/nova/schema
│   │   ├── diagnostic.ts            Diagnostic type, factory, suggest()
│   │   ├── types.ts                 AppSpec, PageSpec, SectionSpec, refs
│   │   └── validate.ts              raw parsed value → AppSpec | Diagnostic[]
│   └── compile/
│       ├── index.ts                 compileApp(); public surface of /compile
│       ├── config.ts                NovaConfig type (host supplies the value)
│       ├── load.ts                  YAML → { raw, PositionMap }
│       ├── program.ts               ts.Program creation, module export reading
│       ├── catalog.ts               component catalogs → Catalog
│       ├── resolve.ts               AppSpec + Catalog → ResolvedApp
│       ├── emit/
│       │   ├── emitter.ts           Emitter — line buffer + LineMap
│       │   ├── types.ts             emit generated/types.ts
│       │   ├── runtime.ts           emit generated/runtime.tsx
│       │   ├── pages.ts             emit generated/pages.tsx
│       │   ├── handlers.ts          emit generated/handlers.ts
│       │   └── contract.ts          emit generated/__contract.ts
│       └── typecheck.ts             run tsc over generated/, remap diagnostics
└── test/
    ├── fixtures/
    │   ├── catalog/ui.tsx           Light-free component catalog
    │   └── app-basic/               a minimal app: app.yaml, data.ts, actions.ts
    └── *.test.ts
```

---

### Task 1: Package skeleton and diagnostics

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/schema/diagnostic.ts`, `src/schema/index.ts`
- Test: `test/diagnostic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Position = { file: string; line: number; col: number }`; `PositionMap = { at(path: (string | number)[]): Position }`; `Severity = "error" | "warning"`; `Related = Position & { message: string }`; `Diagnostic = { code: string; severity: Severity; message: string; file: string; line: number; col: number; hint?: string; related?: Related[] }`; `diagnostic(code: string, message: string, at: Position, opts?: { severity?: Severity; hint?: string; related?: Related[] }): Diagnostic`; `suggest(name: string, candidates: string[]): string | undefined`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@light/nova",
  "version": "0.0.0",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "exports": {
    "./schema": { "types": "./dist/schema/index.d.ts", "default": "./dist/schema/index.js" },
    "./compile": { "types": "./dist/compile/index.d.ts", "default": "./dist/compile/index.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "yaml": "^2.9.0" },
  "peerDependencies": { "typescript": ">=5.5" },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.1.0",
    "react": "^19.1.0",
    "typescript": "^5.7.2",
    "vitest": "^4.1.11"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "types": ["node"]
  },
  "include": ["src/**/*", "test/**/*", "vitest.config.ts"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, `node_modules/` populated, no errors.

- [ ] **Step 4: Write the failing test**

Create `test/diagnostic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diagnostic, suggest } from "../src/schema/diagnostic.js";

describe("diagnostic", () => {
  it("defaults to error severity and carries the position inline", () => {
    const d = diagnostic("NOVA1001", "unknown key 'sectons'", {
      file: "app.yaml",
      line: 3,
      col: 5,
    });
    expect(d).toEqual({
      code: "NOVA1001",
      severity: "error",
      message: "unknown key 'sectons'",
      file: "app.yaml",
      line: 3,
      col: 5,
    });
  });

  it("omits hint and related when not supplied", () => {
    const d = diagnostic("NOVA1001", "boom", { file: "a.yaml", line: 1, col: 1 });
    expect("hint" in d).toBe(false);
    expect("related" in d).toBe(false);
  });

  it("carries hint, severity and related when supplied", () => {
    const d = diagnostic("NOVA2001", "unknown component 'Tabel'", { file: "a.yaml", line: 9, col: 7 }, {
      severity: "warning",
      hint: "did you mean 'Table'?",
      related: [{ file: "ui.tsx", line: 1, col: 1, message: "catalog defined here" }],
    });
    expect(d.severity).toBe("warning");
    expect(d.hint).toBe("did you mean 'Table'?");
    expect(d.related).toHaveLength(1);
  });
});

describe("suggest", () => {
  it("finds the nearest candidate within edit distance 2", () => {
    expect(suggest("Tabel", ["Table", "StatCard", "Row"])).toBe("Table");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(suggest("Wombat", ["Table", "StatCard", "Row"])).toBeUndefined();
  });

  it("prefers the closest candidate when several are near", () => {
    expect(suggest("Ro", ["Row", "Root", "Table"])).toBe("Row");
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run test/diagnostic.test.ts`
Expected: FAIL — `Cannot find module '../src/schema/diagnostic.js'`.

- [ ] **Step 6: Implement `src/schema/diagnostic.ts`**

```ts
export type Severity = "error" | "warning";

export type Position = { file: string; line: number; col: number };

export type Related = Position & { message: string };

/** Resolves a path within the spec document to a source position. */
export type PositionMap = { at(path: (string | number)[]): Position };

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
  for (const c of [...candidates].sort()) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d <= limit && d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best;
}
```

- [ ] **Step 7: Create `src/schema/index.ts`**

```ts
export { diagnostic, suggest } from "./diagnostic.js";
export type { Diagnostic, Position, Related, Severity } from "./diagnostic.js";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 6 tests.

- [ ] **Step 9: Verify the build and the absence of a root export**

Run: `pnpm build && pnpm typecheck && node -e "import('@light/nova').catch(e => console.log(e.code))"`
Expected: build and typecheck succeed; the node command prints `ERR_PACKAGE_PATH_NOT_EXPORTED` or `ERR_MODULE_NOT_FOUND`, proving there is no root entry point.

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json vitest.config.ts .gitignore src test
git commit -m "feat: package skeleton and diagnostics"
```

---

### Task 2: Spec types

**Files:**
- Create: `src/schema/types.ts`
- Modify: `src/schema/index.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime.
- Produces: `BindingRef`, `ComponentRef`, `PropValue`, `SectionSpec`, `FilterSpec`, `PageSpec`, `AppSpec`, and `parseBinding(text: string): BindingRef | null`, `parseComponentRef(text: string): ComponentRef | null`.

These are the normalised shapes the validator produces and every later task consumes. Raw YAML is never passed beyond `validate()`.

- [ ] **Step 1: Write the failing test**

Create `test/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseBinding, parseComponentRef } from "../src/schema/types.js";

describe("parseBinding", () => {
  it("parses a data reference", () => {
    expect(parseBinding("data#trips")).toEqual({ kind: "data", name: "trips", path: [] });
  });

  it("parses a dotted data path", () => {
    expect(parseBinding("data#trip.km")).toEqual({ kind: "data", name: "trip", path: ["km"] });
  });

  it("parses action, compute, param and filter references", () => {
    expect(parseBinding("actions#saveTravel")).toEqual({ kind: "actions", name: "saveTravel" });
    expect(parseBinding("compute#formatKm")).toEqual({ kind: "compute", name: "formatKm" });
    expect(parseBinding("params.id")).toEqual({ kind: "param", name: "id" });
    expect(parseBinding("filters.month")).toEqual({ kind: "filter", name: "month" });
  });

  it("returns null for a plain string literal", () => {
    expect(parseBinding("This month")).toBeNull();
    expect(parseBinding("data")).toBeNull();
    expect(parseBinding("data#")).toBeNull();
  });
});

describe("parseComponentRef", () => {
  it("parses a bare catalog name", () => {
    expect(parseComponentRef("Table")).toEqual({ kind: "catalog", name: "Table" });
  });

  it("parses a relative module reference", () => {
    expect(parseComponentRef("./views/charts#BridgeChart")).toEqual({
      kind: "local",
      module: "./views/charts",
      name: "BridgeChart",
    });
  });

  it("rejects a lowercase bare name, which JSX would treat as an intrinsic element", () => {
    expect(parseComponentRef("table")).toBeNull();
  });

  it("rejects a relative reference with a lowercase export name", () => {
    expect(parseComponentRef("./views/charts#helper")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/types.test.ts`
Expected: FAIL — `Cannot find module '../src/schema/types.js'`.

- [ ] **Step 3: Implement `src/schema/types.ts`**

```ts
export type BindingRef =
  | { kind: "data"; name: string; path: string[] }
  | { kind: "actions"; name: string }
  | { kind: "compute"; name: string }
  | { kind: "param"; name: string }
  | { kind: "filter"; name: string };

export type ComponentRef =
  | { kind: "catalog"; name: string }
  | { kind: "local"; module: string; name: string };

export type PropValue =
  | { kind: "literal"; value: unknown }
  | { kind: "binding"; ref: BindingRef };

export type SectionSpec = {
  component: ComponentRef;
  props: Record<string, PropValue>;
  children: SectionSpec[];
};

export type FilterSpec = { name: string; type: string; default?: unknown };

export type PageSpec = {
  route: string;
  title?: string;
  filters: FilterSpec[];
  sections: SectionSpec[];
};

export type AppSpec = { pages: PageSpec[] };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const upper = (s: string) => /^[A-Z]/.test(s);

export function parseBinding(text: string): BindingRef | null {
  const hash = text.indexOf("#");
  if (hash > 0) {
    const ns = text.slice(0, hash);
    const rest = text.slice(hash + 1);
    if (rest === "") return null;
    const [name, ...path] = rest.split(".");
    if (name === undefined || !IDENT.test(name)) return null;
    if (path.some((p) => !IDENT.test(p))) return null;
    if (ns === "data") return { kind: "data", name, path };
    if (path.length > 0) return null;
    if (ns === "actions") return { kind: "actions", name };
    if (ns === "compute") return { kind: "compute", name };
    return null;
  }
  for (const [prefix, kind] of [
    ["params.", "param"],
    ["filters.", "filter"],
  ] as const) {
    if (text.startsWith(prefix)) {
      const name = text.slice(prefix.length);
      return IDENT.test(name) ? { kind, name } : null;
    }
  }
  return null;
}

export function parseComponentRef(text: string): ComponentRef | null {
  const hash = text.indexOf("#");
  if (hash < 0) {
    return IDENT.test(text) && upper(text) ? { kind: "catalog", name: text } : null;
  }
  const module = text.slice(0, hash);
  const name = text.slice(hash + 1);
  if (!module.startsWith(".") || !IDENT.test(name) || !upper(name)) return null;
  return { kind: "local", module, name };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all Task 1 and Task 2 tests.

- [ ] **Step 5: Re-export from `src/schema/index.ts`**

Replace the file with:

```ts
export { diagnostic, suggest } from "./diagnostic.js";
export type { Diagnostic, Position, PositionMap, Related, Severity } from "./diagnostic.js";
export { parseBinding, parseComponentRef } from "./types.js";
export type {
  AppSpec,
  BindingRef,
  ComponentRef,
  FilterSpec,
  PageSpec,
  PropValue,
  SectionSpec,
} from "./types.js";
```

- [ ] **Step 6: Commit**

```bash
git add src/schema/types.ts src/schema/index.ts test/types.test.ts
git commit -m "feat: spec types and reference parsing"
```

---

### Task 3: YAML loading with source positions

**Files:**
- Create: `src/compile/load.ts`
- Test: `test/load.test.ts`

**Interfaces:**
- Consumes: `Diagnostic`, `Position`, `diagnostic` from `src/schema/diagnostic.js`.
- Produces: `loadSpecFile(file: string, source: string): { raw: unknown; positions: PositionMap; diagnostics: Diagnostic[] }`.

`positions.at(path)` returns the position of the **value** at that path. When the exact path does not exist (which happens when reporting a missing key), it falls back to the nearest existing ancestor, so a diagnostic always has somewhere sensible to point.

- [ ] **Step 1: Write the failing test**

Create `test/load.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadSpecFile } from "../src/compile/load.js";

const SRC = ['pages:', '  "/":', "    title: Trips", "    sections:", "      - Table", ""].join("\n");

describe("loadSpecFile", () => {
  it("parses the document into plain JS values", () => {
    const { raw, diagnostics } = loadSpecFile("app.yaml", SRC);
    expect(diagnostics).toEqual([]);
    expect(raw).toEqual({ pages: { "/": { title: "Trips", sections: ["Table"] } } });
  });

  it("maps a nested path to the position of its value", () => {
    const { positions } = loadSpecFile("app.yaml", SRC);
    expect(positions.at(["pages", "/", "title"])).toEqual({ file: "app.yaml", line: 3, col: 12 });
  });

  it("maps a sequence index", () => {
    const { positions } = loadSpecFile("app.yaml", SRC);
    expect(positions.at(["pages", "/", "sections", 0])).toEqual({
      file: "app.yaml",
      line: 5,
      col: 9,
    });
  });

  it("falls back to the nearest existing ancestor for a missing path", () => {
    const { positions } = loadSpecFile("app.yaml", SRC);
    expect(positions.at(["pages", "/", "nope"])).toEqual({ file: "app.yaml", line: 3, col: 5 });
  });

  it("returns a diagnostic instead of throwing on malformed YAML", () => {
    const { raw, diagnostics } = loadSpecFile("app.yaml", "pages:\n  - a\n  b: c\n");
    expect(raw).toBeNull();
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.code).toBe("NOVA1000");
    expect(diagnostics[0]!.file).toBe("app.yaml");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/load.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/load.js'`.

- [ ] **Step 3: Implement `src/compile/load.ts`**

```ts
import { LineCounter, isCollection, isNode, parseDocument } from "yaml";
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
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });

  const start: Position = { file, line: 1, col: 1 };
  const posOf = (offset: number): Position => {
    const { line, col } = lineCounter.linePos(offset);
    return { file, line, col };
  };

  const positions: PositionMap = {
    at(path) {
      for (let i = path.length; i >= 0; i--) {
        const node = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
        if (isNode(node) && node.range) return posOf(node.range[0]);
        if (isCollection(node) && node.range) return posOf(node.range[0]);
      }
      return start;
    },
  };

  const diagnostics = doc.errors.map((e) =>
    diagnostic("NOVA1000", e.message, posOf(e.pos[0])),
  );

  return { raw: diagnostics.length > 0 ? null : doc.toJS(), positions, diagnostics };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/load.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compile/load.ts test/load.test.ts
git commit -m "feat: position-aware YAML loading"
```

---

### Task 4: Structural validation

**Files:**
- Create: `src/schema/validate.ts`
- Modify: `src/schema/index.ts`
- Test: `test/validate.test.ts`

**Interfaces:**
- Consumes: `PositionMap` from `src/schema/diagnostic.js`; the types from Task 2; `diagnostic`/`suggest` from Task 1.
- Produces: `validate(raw: unknown, positions: PositionMap): { spec: AppSpec | null; diagnostics: Diagnostic[] }`.

Diagnostic codes introduced here, fixed forever:

| Code | Meaning |
| --- | --- |
| `NOVA1001` | unknown key |
| `NOVA1002` | missing required key |
| `NOVA1003` | wrong value type |
| `NOVA1004` | malformed binding or component reference |
| `NOVA1005` | invalid route pattern |

Validation collects every diagnostic rather than stopping at the first, so one run reports every problem in the file.

- [ ] **Step 1: Write the failing test**

Create `test/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadSpecFile } from "../src/compile/load.js";
import { validate } from "../src/schema/validate.js";

function check(src: string) {
  const { raw, positions } = loadSpecFile("app.yaml", src);
  return validate(raw, positions);
}

const GOOD = [
  "pages:",
  '  "/":',
  "    title: Mileage",
  "    filters:",
  "      month: { type: month, default: current }",
  "    sections:",
  "      - StatCard: { label: This month, value: data#monthlyTotal }",
  "      - Table:",
  "          rows: data#trips",
  "          columns: [date, km]",
  "",
].join("\n");

describe("validate", () => {
  it("normalises a valid document", () => {
    const { spec, diagnostics } = check(GOOD);
    expect(diagnostics).toEqual([]);
    expect(spec!.pages).toHaveLength(1);
    const page = spec!.pages[0]!;
    expect(page.route).toBe("/");
    expect(page.title).toBe("Mileage");
    expect(page.filters).toEqual([{ name: "month", type: "month", default: "current" }]);
    expect(page.sections).toHaveLength(2);
    expect(page.sections[0]!.component).toEqual({ kind: "catalog", name: "StatCard" });
    expect(page.sections[0]!.props.label).toEqual({ kind: "literal", value: "This month" });
    expect(page.sections[0]!.props.value).toEqual({
      kind: "binding",
      ref: { kind: "data", name: "monthlyTotal", path: [] },
    });
    expect(page.sections[1]!.props.columns).toEqual({ kind: "literal", value: ["date", "km"] });
  });

  it("reports an unknown page key with a suggestion", () => {
    const { diagnostics } = check('pages:\n  "/":\n    titel: Trips\n    sections: []\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("NOVA1001");
    expect(diagnostics[0]!.line).toBe(3);
    expect(diagnostics[0]!.hint).toBe("did you mean 'title'?");
  });

  it("reports a missing required key", () => {
    const { spec, diagnostics } = check('pages:\n  "/":\n    title: Trips\n');
    expect(spec).toBeNull();
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1002");
  });

  it("reports a wrong value type", () => {
    const { diagnostics } = check('pages:\n  "/":\n    sections: "nope"\n');
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1003");
  });

  it("reports a malformed component reference", () => {
    const { diagnostics } = check('pages:\n  "/":\n    sections:\n      - table: {}\n');
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1004");
  });

  it("reports an invalid route", () => {
    const { diagnostics } = check("pages:\n  trips:\n    sections: []\n");
    expect(diagnostics.map((d) => d.code)).toContain("NOVA1005");
  });

  it("collects every problem rather than stopping at the first", () => {
    const { diagnostics } = check(
      'pages:\n  "/":\n    titel: a\n    sections: "nope"\n  bad:\n    sections: []\n',
    );
    expect(diagnostics.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/validate.test.ts`
Expected: FAIL — `Cannot find module '../src/schema/validate.js'`.

- [ ] **Step 3: Implement `src/schema/validate.ts`**

```ts
import { diagnostic, suggest, type Diagnostic, type PositionMap } from "./diagnostic.js";
import {
  parseBinding,
  parseComponentRef,
  type AppSpec,
  type FilterSpec,
  type PageSpec,
  type PropValue,
  type SectionSpec,
} from "./types.js";

const PAGE_KEYS = ["title", "filters", "sections"];
const FILTER_KEYS = ["type", "default"];
const ROUTE = /^\/(?:[A-Za-z0-9\-_]+|:[A-Za-z_$][A-Za-z0-9_$]*)?(?:\/(?:[A-Za-z0-9\-_]+|:[A-Za-z_$][A-Za-z0-9_$]*))*$/;

type Path = (string | number)[];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function validate(
  raw: unknown,
  positions: PositionMap,
): { spec: AppSpec | null; diagnostics: Diagnostic[] } {
  const out: Diagnostic[] = [];
  const err = (code: string, message: string, path: Path, hint?: string) => {
    out.push(diagnostic(code, message, positions.at(path), hint === undefined ? {} : { hint }));
  };

  if (!isRecord(raw)) {
    err("NOVA1003", "the spec must be a mapping", []);
    return { spec: null, diagnostics: out };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "pages") err("NOVA1001", `unknown key '${key}'`, [key], hintFor(key, ["pages"]));
  }
  const rawPages = raw.pages;
  if (rawPages === undefined) {
    err("NOVA1002", "missing required key 'pages'", []);
    return { spec: null, diagnostics: out };
  }
  if (!isRecord(rawPages)) {
    err("NOVA1003", "'pages' must be a mapping of route to page", ["pages"]);
    return { spec: null, diagnostics: out };
  }

  const pages: PageSpec[] = [];
  for (const route of Object.keys(rawPages).sort()) {
    const page = validatePage(route, rawPages[route], ["pages", route], err);
    if (page) pages.push(page);
  }

  const fatal = out.some((d) => d.severity === "error");
  return { spec: fatal ? null : { pages }, diagnostics: out };

  function hintFor(key: string, candidates: string[]): string | undefined {
    const s = suggest(key, candidates);
    return s === undefined ? undefined : `did you mean '${s}'?`;
  }

  function validatePage(
    route: string,
    value: unknown,
    path: Path,
    report: typeof err,
  ): PageSpec | null {
    if (!ROUTE.test(route)) {
      report("NOVA1005", `invalid route '${route}' — routes start with '/'`, path);
      return null;
    }
    if (!isRecord(value)) {
      report("NOVA1003", `page '${route}' must be a mapping`, path);
      return null;
    }
    for (const key of Object.keys(value)) {
      if (!PAGE_KEYS.includes(key)) {
        report("NOVA1001", `unknown key '${key}'`, [...path, key], hintFor(key, PAGE_KEYS));
      }
    }

    let title: string | undefined;
    if (value.title !== undefined) {
      if (typeof value.title !== "string") {
        report("NOVA1003", "'title' must be a string", [...path, "title"]);
      } else {
        title = value.title;
      }
    }

    const filters = validateFilters(value.filters, [...path, "filters"], report);

    if (value.sections === undefined) {
      report("NOVA1002", `page '${route}' is missing required key 'sections'`, path);
      return null;
    }
    if (!Array.isArray(value.sections)) {
      report("NOVA1003", "'sections' must be a list", [...path, "sections"]);
      return null;
    }
    const sections: SectionSpec[] = [];
    value.sections.forEach((raw, i) => {
      const s = validateSection(raw, [...path, "sections", i], report);
      if (s) sections.push(s);
    });

    const page: PageSpec = { route, filters, sections };
    if (title !== undefined) page.title = title;
    return page;
  }

  function validateFilters(value: unknown, path: Path, report: typeof err): FilterSpec[] {
    if (value === undefined) return [];
    if (!isRecord(value)) {
      report("NOVA1003", "'filters' must be a mapping", path);
      return [];
    }
    const filters: FilterSpec[] = [];
    for (const name of Object.keys(value).sort()) {
      const raw = value[name];
      if (!isRecord(raw)) {
        report("NOVA1003", `filter '${name}' must be a mapping`, [...path, name]);
        continue;
      }
      for (const key of Object.keys(raw)) {
        if (!FILTER_KEYS.includes(key)) {
          report("NOVA1001", `unknown key '${key}'`, [...path, name, key], hintFor(key, FILTER_KEYS));
        }
      }
      if (typeof raw.type !== "string") {
        report("NOVA1002", `filter '${name}' is missing required key 'type'`, [...path, name]);
        continue;
      }
      const filter: FilterSpec = { name, type: raw.type };
      if (raw.default !== undefined) filter.default = raw.default;
      filters.push(filter);
    }
    return filters;
  }

  function validateSection(value: unknown, path: Path, report: typeof err): SectionSpec | null {
    if (typeof value === "string") {
      const ref = parseComponentRef(value);
      if (!ref) {
        report("NOVA1004", `'${value}' is not a component reference`, path, componentHint(value));
        return null;
      }
      return { component: ref, props: {}, children: [] };
    }
    if (!isRecord(value)) {
      report("NOVA1003", "a section must be a string or a single-key mapping", path);
      return null;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      report("NOVA1003", `a section must have exactly one key, found ${keys.length}`, path);
      return null;
    }
    const key = keys[0]!;
    const ref = parseComponentRef(key);
    if (!ref) {
      report("NOVA1004", `'${key}' is not a component reference`, [...path, key], componentHint(key));
      return null;
    }
    const body = value[key];
    if (body === null || body === undefined) return { component: ref, props: {}, children: [] };
    if (!isRecord(body)) {
      report("NOVA1003", `props for '${key}' must be a mapping`, [...path, key]);
      return null;
    }

    const props: Record<string, PropValue> = {};
    const children: SectionSpec[] = [];
    for (const prop of Object.keys(body).sort()) {
      if (prop === "children") {
        const raw = body.children;
        if (!Array.isArray(raw)) {
          report("NOVA1003", "'children' must be a list", [...path, key, "children"]);
          continue;
        }
        raw.forEach((child, i) => {
          const c = validateSection(child, [...path, key, "children", i], report);
          if (c) children.push(c);
        });
        continue;
      }
      props[prop] = toPropValue(body[prop]);
    }
    return { component: ref, props, children };
  }

  function componentHint(text: string): string | undefined {
    return /^[a-z]/.test(text)
      ? "component names start with a capital letter; lowercase names are HTML elements"
      : undefined;
  }

  function toPropValue(value: unknown): PropValue {
    if (typeof value === "string") {
      const ref = parseBinding(value);
      if (ref) return { kind: "binding", ref };
    }
    return { kind: "literal", value };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/validate.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Re-export `validate` from `src/schema/index.ts`**

Add to the file:

```ts
export { validate } from "./validate.js";
```

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/schema/validate.ts src/schema/index.ts test/validate.test.ts
git commit -m "feat: structural spec validation"
```

---

### Task 5: TypeScript program and module export reading

**Files:**
- Create: `src/compile/program.ts`
- Create: `test/fixtures/catalog/ui.tsx`
- Create: `test/fixtures/app-basic/data.ts`, `test/fixtures/app-basic/actions.ts`, `test/fixtures/tsconfig.json`
- Test: `test/program.test.ts`

**Interfaces:**
- Consumes: `Diagnostic`, `diagnostic` from Task 1.
- Produces: `createProgram(opts: { tsconfigPath: string; roots: string[] }): { program: ts.Program; checker: ts.TypeChecker } | null`; `moduleExports(program: ts.Program, file: string): ExportInfo[]` where `ExportInfo = { name: string; callable: boolean; file: string; line: number; col: number }`; `resolveModule(specifier: string, containingFile: string, tsconfigPath: string): string | null`.

**Note on component detection.** Nova does *not* read props types. A component is an exported, callable binding whose name starts with a capital letter — the same rule JSX itself enforces, since a lowercase tag is an intrinsic HTML element. Props correctness is proven later by typechecking the emitted JSX (Task 10), which is more accurate than any introspection and is what spec decision D5 requires.

- [ ] **Step 1: Create the fixture catalog**

`test/fixtures/catalog/ui.tsx`:

```tsx
import * as React from "react";

export function Table(props: {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  empty?: string;
}): React.ReactElement {
  return <table data-columns={props.columns.join(",")}>{props.rows.length}</table>;
}

export function StatCard(props: { label: string; value: string }): React.ReactElement {
  return <div>{props.label}: {props.value}</div>;
}

export function Loading(props: { label?: string }): React.ReactElement {
  return <p>{props.label ?? "Loading"}</p>;
}

export function ErrorNotice(props: { children: React.ReactNode }): React.ReactElement {
  return <p role="alert">{props.children}</p>;
}

export function EmptyState(props: { title: string }): React.ReactElement {
  return <p>{props.title}</p>;
}

export const MONTHS = ["Jan", "Feb"];

export function formatKm(n: number): string {
  return `${n} km`;
}
```

- [ ] **Step 2: Create the fixture app and its tsconfig**

`test/fixtures/app-basic/data.ts`:

```ts
export type Trip = { date: string; km: number };

export async function trips(input: { month: string }): Promise<Trip[]> {
  return [{ date: `${input.month}-01`, km: 12 }];
}

export async function monthlyTotal(input: { month: string }): Promise<string> {
  return `${input.month}: 12 km`;
}
```

`test/fixtures/app-basic/actions.ts`:

```ts
export async function saveTrip(
  input: { date: string; km: number },
): Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> {
  return input.km > 0 ? { ok: true } : { ok: false, fieldErrors: { km: "must be positive" } };
}
```

`test/fixtures/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

- [ ] **Step 3: Write the failing test**

Create `test/program.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram, moduleExports, resolveModule } from "../src/compile/program.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TSCONFIG = here("./fixtures/tsconfig.json");
const CATALOG = here("./fixtures/catalog/ui.tsx");
const DATA = here("./fixtures/app-basic/data.ts");

describe("createProgram", () => {
  it("builds a program from a tsconfig and roots", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] });
    expect(p).not.toBeNull();
    expect(p!.program.getSourceFile(CATALOG)).toBeDefined();
  });

  it("returns null when the tsconfig does not exist", () => {
    expect(createProgram({ tsconfigPath: here("./nope.json"), roots: [] })).toBeNull();
  });
});

describe("moduleExports", () => {
  it("lists every export with callability and position", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    const names = moduleExports(p.program, CATALOG).map((e) => e.name);
    expect(names).toEqual(["EmptyState", "ErrorNotice", "Loading", "MONTHS", "StatCard", "Table", "formatKm"]);
  });

  it("marks functions callable and constants not", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    const byName = new Map(moduleExports(p.program, CATALOG).map((e) => [e.name, e]));
    expect(byName.get("Table")!.callable).toBe(true);
    expect(byName.get("formatKm")!.callable).toBe(true);
    expect(byName.get("MONTHS")!.callable).toBe(false);
  });

  it("reports the declaration position", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    const table = moduleExports(p.program, CATALOG).find((e) => e.name === "Table")!;
    expect(table.file).toBe(CATALOG);
    expect(table.line).toBe(3);
  });

  it("reads a plain .ts module", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [DATA] })!;
    expect(moduleExports(p.program, DATA).map((e) => e.name)).toEqual([
      "Trip",
      "monthlyTotal",
      "trips",
    ]);
  });

  it("returns an empty list for a file not in the program", () => {
    const p = createProgram({ tsconfigPath: TSCONFIG, roots: [CATALOG] })!;
    expect(moduleExports(p.program, here("./fixtures/missing.ts"))).toEqual([]);
  });
});

describe("resolveModule", () => {
  it("resolves a relative specifier to a file path", () => {
    expect(resolveModule("./data", here("./fixtures/app-basic/app.yaml"), TSCONFIG)).toBe(DATA);
  });

  it("returns null for an unresolvable specifier", () => {
    expect(resolveModule("@nope/nothing", CATALOG, TSCONFIG)).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run test/program.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/program.js'`.

- [ ] **Step 5: Implement `src/compile/program.ts`**

```ts
import { dirname } from "node:path";
import ts from "typescript";

export type ExportInfo = {
  name: string;
  callable: boolean;
  file: string;
  line: number;
  col: number;
};

export type ProgramHandle = { program: ts.Program; checker: ts.TypeChecker };

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
  const program = ts.createProgram({ rootNames, options: parsed.options });
  return { program, checker: program.getTypeChecker() };
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
    out.push({
      name: symbol.getName(),
      callable: checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0,
      file: decl.fileName,
      line: line + 1,
      col: character + 1,
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run test/program.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/compile/program.ts test/program.test.ts test/fixtures
git commit -m "feat: TypeScript program and module export reading"
```

---

### Task 6: Component catalogs

**Files:**
- Create: `src/compile/config.ts`, `src/compile/catalog.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Consumes: `createProgram`, `moduleExports`, `resolveModule` from Task 5; `diagnostic`, `suggest` from Task 1.
- Produces:
  - `NovaConfig = { components: string[]; states: { loading: string; error: string; empty: string }; outDir: string; tsconfigPath: string; importExtension?: "" | ".js" }`
  - `CatalogEntry = { name: string; module: string; file: string }`
  - `Catalog = { get(name: string): CatalogEntry | undefined; names(): string[] }`
  - `readCatalogs(config: NovaConfig, containingFile: string): { catalog: Catalog; diagnostics: Diagnostic[] }`

New diagnostic codes:

| Code | Meaning |
| --- | --- |
| `NOVA2000` | a catalog module could not be resolved |
| `NOVA2010` | two catalogs export the same component name |

**Config is never loaded from disk.** The host imports its own `nova.config.ts` and passes the value to `compileApp`. `importExtension` defaults to `""`; hosts on `nodenext` resolution pass `".js"`.

- [ ] **Step 1: Write the failing test**

Create `test/catalog.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const APP = here("./fixtures/app-basic/app.yaml");

const config = (components: string[]): NovaConfig => ({
  components,
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: here("./fixtures/tsconfig.json"),
});

describe("readCatalogs", () => {
  it("collects capitalised callable exports and ignores the rest", () => {
    const { catalog, diagnostics } = readCatalogs(config(["../catalog/ui"]), APP);
    expect(diagnostics).toEqual([]);
    expect(catalog.names()).toEqual(["EmptyState", "ErrorNotice", "Loading", "StatCard", "Table"]);
  });

  it("records the module specifier to emit, not the resolved path", () => {
    const { catalog } = readCatalogs(config(["../catalog/ui"]), APP);
    expect(catalog.get("Table")!.module).toBe("../catalog/ui");
    expect(catalog.get("Table")!.file).toBe(here("./fixtures/catalog/ui.tsx"));
  });

  it("returns undefined for an unknown name", () => {
    const { catalog } = readCatalogs(config(["../catalog/ui"]), APP);
    expect(catalog.get("Tabel")).toBeUndefined();
  });

  it("reports an unresolvable catalog module", () => {
    const { diagnostics } = readCatalogs(config(["@nope/ui"]), APP);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("NOVA2000");
  });

  it("reports a name exported by two catalogs", () => {
    const { diagnostics } = readCatalogs(config(["../catalog/ui", "../catalog/ui"]), APP);
    expect(diagnostics.map((d) => d.code)).toContain("NOVA2010");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/catalog.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/catalog.js'`.

- [ ] **Step 3: Implement `src/compile/config.ts`**

```ts
export type NovaConfig = {
  /** Module specifiers whose capitalised callable exports are usable in specs. */
  components: string[];
  /** Catalog component names used for the generated loading, error and empty states. */
  states: { loading: string; error: string; empty: string };
  /** Directory name, relative to the app folder, for emitted files. */
  outDir: string;
  /** tsconfig used to resolve modules and typecheck emitted output. */
  tsconfigPath: string;
  /** Extension appended to relative imports in emitted code. "" for bundler resolution. */
  importExtension?: "" | ".js";
};
```

- [ ] **Step 4: Implement `src/compile/catalog.ts`**

```ts
import { diagnostic, type Diagnostic } from "../schema/diagnostic.js";
import type { NovaConfig } from "./config.js";
import { createProgram, moduleExports, resolveModule } from "./program.js";

export type CatalogEntry = { name: string; module: string; file: string };

export type Catalog = {
  get(name: string): CatalogEntry | undefined;
  names(): string[];
};

const isComponentName = (name: string) => /^[A-Z]/.test(name);

export function readCatalogs(
  config: NovaConfig,
  containingFile: string,
): { catalog: Catalog; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const at = { file: containingFile, line: 1, col: 1 };

  const resolved: { module: string; file: string }[] = [];
  for (const specifier of config.components) {
    const file = resolveModule(specifier, containingFile, config.tsconfigPath);
    if (file === null) {
      diagnostics.push(
        diagnostic("NOVA2000", `cannot resolve catalog module '${specifier}'`, at, {
          hint: "check nova.config components against the host's tsconfig paths",
        }),
      );
      continue;
    }
    resolved.push({ module: specifier, file });
  }

  const entries = new Map<string, CatalogEntry>();
  const handle = createProgram({
    tsconfigPath: config.tsconfigPath,
    roots: resolved.map((r) => r.file),
  });
  if (handle) {
    for (const { module, file } of resolved) {
      for (const exported of moduleExports(handle.program, file)) {
        if (!exported.callable || !isComponentName(exported.name)) continue;
        const existing = entries.get(exported.name);
        if (existing) {
          diagnostics.push(
            diagnostic(
              "NOVA2010",
              `component '${exported.name}' is exported by both '${existing.module}' and '${module}'`,
              at,
              { hint: "rename one, or remove a catalog from nova.config" },
            ),
          );
          continue;
        }
        entries.set(exported.name, { name: exported.name, module, file });
      }
    }
  }

  const catalog: Catalog = {
    get: (name) => entries.get(name),
    names: () => [...entries.keys()].sort(),
  };
  return { catalog, diagnostics };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/catalog.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/compile/config.ts src/compile/catalog.ts test/catalog.test.ts
git commit -m "feat: component catalog introspection"
```

---

### Task 7: Name resolution

**Files:**
- Create: `src/compile/resolve.ts`
- Create: `test/fixtures/app-basic/app.yaml`
- Test: `test/resolve.test.ts`

**Interfaces:**
- Consumes: `AppSpec` and refs from Task 2; `Catalog` from Task 6; `createProgram`, `moduleExports`, `resolveModule` from Task 5.
- Produces:
  - `ModuleBinding = { name: string; module: string }`
  - `ResolvedApp = { spec: AppSpec; components: ModuleBinding[]; loaders: string[]; actions: string[]; computes: string[] }`
  - `resolveApp(spec: AppSpec, ctx: { config: NovaConfig; appDir: string; specFile: string; catalog: Catalog; positions: PositionMap }): { resolved: ResolvedApp | null; diagnostics: Diagnostic[] }`

`components` is the deduplicated, sorted list of every component the spec uses, each with the module specifier to import it from. `loaders`, `actions` and `computes` are the sorted names actually referenced.

New diagnostic codes:

| Code | Meaning |
| --- | --- |
| `NOVA2001` | unknown component |
| `NOVA2002` | unknown `data#` export |
| `NOVA2003` | unknown `actions#` export |
| `NOVA2004` | unknown `compute#` export |
| `NOVA2005` | `params.x` not present in the route |
| `NOVA2006` | `filters.x` not declared on the page |

- [ ] **Step 1: Create the fixture app spec**

`test/fixtures/app-basic/app.yaml`:

```yaml
pages:
  "/":
    title: Trips
    filters:
      month: { type: month, default: current }
    sections:
      - StatCard: { label: This month, value: data#monthlyTotal }
      - Table:
          rows: data#trips
          columns: [date, km]
          empty: No trips yet
```

- [ ] **Step 2: Write the failing test**

Create `test/resolve.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { loadSpecFile } from "../src/compile/load.js";
import { resolveApp } from "../src/compile/resolve.js";
import { validate } from "../src/schema/validate.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SPEC_FILE = here("./fixtures/app-basic/app.yaml");
const APP_DIR = dirname(SPEC_FILE);

const config: NovaConfig = {
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: here("./fixtures/tsconfig.json"),
};

function run(source = readFileSync(SPEC_FILE, "utf8")) {
  const { raw, positions } = loadSpecFile(SPEC_FILE, source);
  const { spec } = validate(raw, positions);
  const { catalog } = readCatalogs(config, SPEC_FILE);
  return resolveApp(spec!, { config, appDir: APP_DIR, specFile: SPEC_FILE, catalog, positions });
}

describe("resolveApp", () => {
  it("resolves the fixture app with no diagnostics", () => {
    const { resolved, diagnostics } = run();
    expect(diagnostics).toEqual([]);
    expect(resolved).not.toBeNull();
  });

  it("collects components with the module to import them from", () => {
    const { resolved } = run();
    expect(resolved!.components).toEqual([
      { name: "EmptyState", module: "../catalog/ui" },
      { name: "ErrorNotice", module: "../catalog/ui" },
      { name: "Loading", module: "../catalog/ui" },
      { name: "StatCard", module: "../catalog/ui" },
      { name: "Table", module: "../catalog/ui" },
    ]);
  });

  it("collects only the loaders the spec actually references", () => {
    const { resolved } = run();
    expect(resolved!.loaders).toEqual(["monthlyTotal", "trips"]);
    expect(resolved!.actions).toEqual([]);
  });

  it("reports an unknown component with a suggestion", () => {
    const { diagnostics } = run('pages:\n  "/":\n    sections:\n      - Tabel: {}\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("NOVA2001");
    expect(diagnostics[0]!.hint).toBe("did you mean 'Table'?");
  });

  it("reports an unknown data export", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: data#nope }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2002"]);
  });

  it("reports a param that the route does not declare", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: params.id }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2005"]);
  });

  it("accepts a param the route does declare", () => {
    const { diagnostics } = run(
      'pages:\n  "/trip/:id":\n    sections:\n      - StatCard: { label: a, value: params.id }\n',
    );
    expect(diagnostics).toEqual([]);
  });

  it("reports a filter the page does not declare", () => {
    const { diagnostics } = run(
      'pages:\n  "/":\n    sections:\n      - StatCard: { label: a, value: filters.month }\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["NOVA2006"]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/resolve.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/resolve.js'`.

- [ ] **Step 4: Implement `src/compile/resolve.ts`**

```ts
import { join } from "node:path";
import { diagnostic, suggest, type Diagnostic } from "../schema/diagnostic.js";
import type { AppSpec, PageSpec, SectionSpec } from "../schema/types.js";
import type { Catalog } from "./catalog.js";
import type { NovaConfig } from "./config.js";
import type { PositionMap } from "./load.js";
import { createProgram, moduleExports } from "./program.js";

export type ModuleBinding = { name: string; module: string };

export type ResolvedApp = {
  spec: AppSpec;
  components: ModuleBinding[];
  loaders: string[];
  actions: string[];
  computes: string[];
};

type Ctx = {
  config: NovaConfig;
  appDir: string;
  specFile: string;
  catalog: Catalog;
  positions: PositionMap;
};

const sorted = (s: Set<string>) => [...s].sort();

function exportsOf(appDir: string, base: string, tsconfigPath: string): Set<string> {
  for (const ext of [".ts", ".tsx"]) {
    const file = join(appDir, base + ext);
    const handle = createProgram({ tsconfigPath, roots: [file] });
    if (!handle || !handle.program.getSourceFile(file)) continue;
    return new Set(moduleExports(handle.program, file).map((e) => e.name));
  }
  return new Set();
}

export function resolveApp(
  spec: AppSpec,
  ctx: Ctx,
): { resolved: ResolvedApp | null; diagnostics: Diagnostic[] } {
  const out: Diagnostic[] = [];
  const components = new Map<string, ModuleBinding>();
  const loaders = new Set<string>();
  const actions = new Set<string>();
  const computes = new Set<string>();

  const dataExports = exportsOf(ctx.appDir, "data", ctx.config.tsconfigPath);
  const actionExports = exportsOf(ctx.appDir, "actions", ctx.config.tsconfigPath);
  const computeExports = exportsOf(ctx.appDir, "compute", ctx.config.tsconfigPath);

  for (const page of spec.pages) {
    const routeParams = new Set(
      page.route
        .split("/")
        .filter((s) => s.startsWith(":"))
        .map((s) => s.slice(1)),
    );
    const filterNames = new Set(page.filters.map((f) => f.name));
    walk(page.sections, page, routeParams, filterNames, ["pages", page.route, "sections"]);
  }

  // Every generated page can render these three states, so they are always imported.
  for (const name of [ctx.config.states.loading, ctx.config.states.error, ctx.config.states.empty]) {
    const entry = ctx.catalog.get(name);
    if (!entry) {
      out.push(
        diagnostic(
          "NOVA2001",
          `state component '${name}' is not in any catalog`,
          ctx.positions.at([]),
          { hint: `available: ${ctx.catalog.names().join(", ")}` },
        ),
      );
      continue;
    }
    components.set(name, { name, module: entry.module });
  }

  const fatal = out.some((d) => d.severity === "error");
  return {
    resolved: fatal
      ? null
      : {
          spec,
          components: [...components.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
          loaders: sorted(loaders),
          actions: sorted(actions),
          computes: sorted(computes),
        },
    diagnostics: out,
  };

  function walk(
    sections: SectionSpec[],
    page: PageSpec,
    routeParams: Set<string>,
    filterNames: Set<string>,
    path: (string | number)[],
  ): void {
    sections.forEach((section, i) => {
      const at = [...path, i];
      if (section.component.kind === "catalog") {
        const name = section.component.name;
        const entry = ctx.catalog.get(name);
        if (!entry) {
          const s = suggest(name, ctx.catalog.names());
          out.push(
            diagnostic("NOVA2001", `unknown component '${name}'`, ctx.positions.at(at), {
              hint:
                s === undefined
                  ? `available: ${ctx.catalog.names().join(", ")}`
                  : `did you mean '${s}'?`,
            }),
          );
        } else {
          components.set(name, { name, module: entry.module });
        }
      } else {
        components.set(`${section.component.module}#${section.component.name}`, {
          name: section.component.name,
          module: section.component.module,
        });
      }

      for (const propName of Object.keys(section.props).sort()) {
        const value = section.props[propName]!;
        if (value.kind !== "binding") continue;
        const ref = value.ref;
        const propAt = ctx.positions.at([...at, propName]);
        if (ref.kind === "data") {
          if (!dataExports.has(ref.name)) {
            report("NOVA2002", `data.ts has no export '${ref.name}'`, propAt, dataExports, ref.name);
          } else loaders.add(ref.name);
        } else if (ref.kind === "actions") {
          if (!actionExports.has(ref.name)) {
            report("NOVA2003", `actions.ts has no export '${ref.name}'`, propAt, actionExports, ref.name);
          } else actions.add(ref.name);
        } else if (ref.kind === "compute") {
          if (!computeExports.has(ref.name)) {
            report("NOVA2004", `compute.ts has no export '${ref.name}'`, propAt, computeExports, ref.name);
          } else computes.add(ref.name);
        } else if (ref.kind === "param") {
          if (!routeParams.has(ref.name)) {
            out.push(
              diagnostic("NOVA2005", `route '${page.route}' has no parameter ':${ref.name}'`, propAt),
            );
          }
        } else if (!filterNames.has(ref.name)) {
          out.push(
            diagnostic("NOVA2006", `page '${page.route}' declares no filter '${ref.name}'`, propAt),
          );
        }
      }

      walk(section.children, page, routeParams, filterNames, [...at, "children"]);
    });
  }

  function report(
    code: string,
    message: string,
    at: { file: string; line: number; col: number },
    available: Set<string>,
    name: string,
  ): void {
    const s = suggest(name, [...available]);
    out.push(diagnostic(code, message, at, s === undefined ? {} : { hint: `did you mean '${s}'?` }));
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/resolve.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/compile/resolve.ts test/resolve.test.ts test/fixtures/app-basic/app.yaml
git commit -m "feat: name resolution against catalogs and app modules"
```

---

### Task 8: Emitter and the line map

**Files:**
- Create: `src/compile/emit/emitter.ts`
- Test: `test/emitter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SpecPath = (string | number)[]`; `LineMap = Map<number, SpecPath>`; `class Emitter { line(text?: string, origin?: SpecPath): this; lines(texts: string[], origin?: SpecPath): this; indent(): this; dedent(): this; text(): string; map(): LineMap }`.

Every emitter writes through this class so the line map is built as a side effect of emission rather than reconstructed afterwards. Output always ends with exactly one trailing newline, which is part of what makes emission byte-deterministic.

- [ ] **Step 1: Write the failing test**

Create `test/emitter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Emitter } from "../src/compile/emit/emitter.js";

describe("Emitter", () => {
  it("joins lines with a single trailing newline", () => {
    const e = new Emitter();
    e.line("a").line("b");
    expect(e.text()).toBe("a\nb\n");
  });

  it("emits a blank line for no argument", () => {
    const e = new Emitter();
    e.line("a").line().line("b");
    expect(e.text()).toBe("a\n\nb\n");
  });

  it("applies two-space indentation and never indents blank lines", () => {
    const e = new Emitter();
    e.line("outer").indent().line("inner").line().dedent().line("outer again");
    expect(e.text()).toBe("outer\n  inner\n\nouter again\n");
  });

  it("records the spec origin of a line, one-based", () => {
    const e = new Emitter();
    e.line("first").line("second", ["pages", "/", "sections", 0]);
    expect(e.map().get(2)).toEqual(["pages", "/", "sections", 0]);
  });

  it("records nothing for lines with no origin", () => {
    const e = new Emitter();
    e.line("first");
    expect(e.map().has(1)).toBe(false);
  });

  it("applies one origin across a block of lines", () => {
    const e = new Emitter();
    e.lines(["a", "b"], ["pages", "/"]);
    expect(e.map().get(1)).toEqual(["pages", "/"]);
    expect(e.map().get(2)).toEqual(["pages", "/"]);
  });

  it("never dedents past zero", () => {
    const e = new Emitter();
    e.dedent().dedent().line("x");
    expect(e.text()).toBe("x\n");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/emitter.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/emit/emitter.js'`.

- [ ] **Step 3: Implement `src/compile/emit/emitter.ts`**

```ts
export type SpecPath = (string | number)[];
export type LineMap = Map<number, SpecPath>;

export class Emitter {
  #lines: string[] = [];
  #map: LineMap = new Map();
  #depth = 0;

  line(text = "", origin?: SpecPath): this {
    this.#lines.push(text === "" ? "" : "  ".repeat(this.#depth) + text);
    if (origin) this.#map.set(this.#lines.length, [...origin]);
    return this;
  }

  lines(texts: string[], origin?: SpecPath): this {
    for (const t of texts) this.line(t, origin);
    return this;
  }

  indent(): this {
    this.#depth++;
    return this;
  }

  dedent(): this {
    this.#depth = Math.max(0, this.#depth - 1);
    return this;
  }

  text(): string {
    return this.#lines.length === 0 ? "" : this.#lines.join("\n") + "\n";
  }

  map(): LineMap {
    return new Map(this.#map);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/emitter.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compile/emit/emitter.ts test/emitter.test.ts
git commit -m "feat: emitter with spec line mapping"
```

---

### Task 9: Emit types, runtime, pages, handlers and contract

**Files:**
- Create: `src/compile/emit/types.ts`, `src/compile/emit/runtime.ts`, `src/compile/emit/pages.ts`, `src/compile/emit/handlers.ts`, `src/compile/emit/contract.ts`
- Test: `test/emit.test.ts`

**Interfaces:**
- Consumes: `ResolvedApp` from Task 7; `Emitter`, `LineMap` from Task 8; `NovaConfig` from Task 6.
- Produces: `EmittedFile = { name: string; text: string; map: LineMap }`, and five functions each returning one — `emitTypes(app, config)`, `emitRuntime(app, config)`, `emitPages(app, config)`, `emitHandlers(app, config)`, `emitContract(app, config)`.

**Why types are derived, not printed.** `emitTypes` never asks the type checker to print a type. It writes TypeScript type operators over the app's own modules, so the generated types are computed by the host's TypeScript from the host's source and cannot drift:

```ts
export type Trips = Awaited<ReturnType<typeof data.trips>>;
```

**Why the runtime is emitted, not shipped.** Generated pages need `useLoader`, `useFilters` and `useAction`. Nova ships no runtime package (spec §2 rule 2, generated code imports nothing from nova), so it emits them into `generated/runtime.tsx`. The file is identical for every app apart from the app's base path.

- [ ] **Step 1: Write the failing test**

Create `test/emit.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogs } from "../src/compile/catalog.js";
import type { NovaConfig } from "../src/compile/config.js";
import { emitContract, emitHandlers, emitPages, emitRuntime, emitTypes } from "../src/compile/emit/index.js";
import { loadSpecFile } from "../src/compile/load.js";
import { resolveApp } from "../src/compile/resolve.js";
import { validate } from "../src/schema/validate.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SPEC_FILE = here("./fixtures/app-basic/app.yaml");

const config: NovaConfig = {
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: here("./fixtures/tsconfig.json"),
};

function resolved() {
  const source = readFileSync(SPEC_FILE, "utf8");
  const { raw, positions } = loadSpecFile(SPEC_FILE, source);
  const { spec } = validate(raw, positions);
  const { catalog } = readCatalogs(config, SPEC_FILE);
  return resolveApp(spec!, {
    config,
    appDir: dirname(SPEC_FILE),
    specFile: SPEC_FILE,
    catalog,
    positions,
  }).resolved!;
}

describe("emitTypes", () => {
  it("derives loader types with TypeScript operators rather than printed text", () => {
    const { text } = emitTypes(resolved(), config);
    expect(text).toContain('import type * as data from "../data";');
    expect(text).toContain("export type Trips = Awaited<ReturnType<typeof data.trips>>;");
    expect(text).toContain("export type MonthlyTotal = Awaited<ReturnType<typeof data.monthlyTotal>>;");
  });

  it("appends the configured import extension", () => {
    const { text } = emitTypes(resolved(), { ...config, importExtension: ".js" });
    expect(text).toContain('import type * as data from "../data.js";');
  });
});

describe("emitRuntime", () => {
  it("emits the hooks generated pages depend on and imports nothing from nova", () => {
    const { text } = emitRuntime(resolved(), config);
    for (const hook of ["useLoader", "useFilters", "useAction"]) {
      expect(text).toContain(`export function ${hook}`);
    }
    expect(text).not.toContain("@light/nova");
  });
});

describe("emitPages", () => {
  it("imports components from their catalog module and nothing from nova", () => {
    const { text } = emitPages(resolved(), config);
    expect(text).toContain('import { EmptyState, ErrorNotice, Loading, StatCard, Table } from "../catalog/ui";');
    expect(text).not.toContain("@light/nova");
    expect(text).not.toContain("@platform/");
  });

  it("exports a structurally typed pages map with no host type import", () => {
    const { text } = emitPages(resolved(), config);
    expect(text).toContain("export const pages: Record<");
    expect(text).toContain('"/": Page_0,');
  });

  it("renders literal props as literals and bindings as expressions", () => {
    const { text } = emitPages(resolved(), config);
    expect(text).toContain('label={"This month"}');
    expect(text).toContain("rows={trips.value}");
  });

  it("maps a generated line back to the section that produced it", () => {
    const { text, map } = emitPages(resolved(), config);
    const lineNo = text.split("\n").findIndex((l) => l.includes("<Table")) + 1;
    expect(map.get(lineNo)).toEqual(["pages", "/", "sections", 1]);
  });
});

describe("emitHandlers", () => {
  it("emits one GET per referenced loader", () => {
    const { text } = emitHandlers(resolved(), config);
    expect(text).toContain('"GET /_data/trips"');
    expect(text).toContain('"GET /_data/monthlyTotal"');
  });

  it("uses Web standard types only", () => {
    const { text } = emitHandlers(resolved(), config);
    expect(text).toContain("(req: Request)");
    expect(text).toContain("Promise<Response>");
    expect(text).not.toContain("@platform/");
  });
});

describe("emitContract", () => {
  it("binds each referenced export to its derived type", () => {
    const { text } = emitContract(resolved(), config);
    expect(text).toContain("const _trips: (input: TripsInput) => Promise<Trips> = data.trips;");
  });
});

describe("determinism", () => {
  it("produces identical bytes on repeated runs", () => {
    const a = resolved();
    const b = resolved();
    for (const emit of [emitTypes, emitRuntime, emitPages, emitHandlers, emitContract]) {
      expect(emit(a, config).text).toBe(emit(b, config).text);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/emit.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/emit/index.js'`.

- [ ] **Step 3: Implement `src/compile/emit/types.ts`**

```ts
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter, type LineMap } from "./emitter.js";

export type EmittedFile = { name: string; text: string; map: LineMap };

export const HEADER = "// AUTO-GENERATED by @light/nova — do not edit.";

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const rel = (config: NovaConfig, path: string) => `${path}${config.importExtension ?? ""}`;

export function emitTypes(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER).line();
  if (app.loaders.length > 0) e.line(`import type * as data from "${rel(config, "../data")}";`);
  if (app.actions.length > 0) e.line(`import type * as actions from "${rel(config, "../actions")}";`);
  if (app.computes.length > 0) e.line(`import type * as compute from "${rel(config, "../compute")}";`);
  e.line();
  for (const name of app.loaders) {
    e.line(`export type ${cap(name)} = Awaited<ReturnType<typeof data.${name}>>;`);
    e.line(`export type ${cap(name)}Input = Parameters<typeof data.${name}>[0];`);
  }
  for (const name of app.actions) {
    e.line(`export type ${cap(name)} = typeof actions.${name};`);
  }
  for (const name of app.computes) {
    e.line(`export type ${cap(name)} = typeof compute.${name};`);
  }
  return { name: "types.ts", text: e.text(), map: e.map() };
}
```

- [ ] **Step 4: Implement `src/compile/emit/runtime.ts`**

```ts
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { HEADER, type EmittedFile } from "./types.js";

export function emitRuntime(_app: ResolvedApp, _config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.lines([
    HEADER,
    '"use client";',
    "",
    'import * as React from "react";',
    "",
    "export type LoaderState<T> = { loading: boolean; error: string | null; value: T | null };",
    "",
    "/** Fetch JSON, discarding responses that arrive after a newer request started. */",
    "export function useLoader<T>(path: string, query: Record<string, string>): LoaderState<T> {",
    "  const [state, setState] = React.useState<LoaderState<T>>({",
    "    loading: true,",
    "    error: null,",
    "    value: null,",
    "  });",
    "  const seq = React.useRef(0);",
    "  const key = JSON.stringify(query);",
    "  React.useEffect(() => {",
    "    const mine = ++seq.current;",
    "    setState((s) => ({ ...s, loading: true, error: null }));",
    "    const url = path + (key === '{}' ? '' : '?' + new URLSearchParams(query).toString());",
    "    fetch(url, { headers: { accept: 'application/json' } })",
    "      .then(async (r) => {",
    "        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);",
    "        return (await r.json()) as T;",
    "      })",
    "      .then((value) => {",
    "        if (seq.current === mine) setState({ loading: false, error: null, value });",
    "      })",
    "      .catch((e: unknown) => {",
    "        if (seq.current === mine) {",
    "          setState({ loading: false, error: e instanceof Error ? e.message : String(e), value: null });",
    "        }",
    "      });",
    "  }, [path, key]);",
    "  return state;",
    "}",
    "",
    "/** Filter values, kept in the query string so a refresh preserves them. */",
    "export function useFilters(",
    "  defaults: Record<string, string>,",
    "): Record<string, string> & { set(name: string, value: string): void } {",
    "  const read = React.useCallback(() => {",
    "    const params = new URLSearchParams(window.location.search);",
    "    const out: Record<string, string> = { ...defaults };",
    "    for (const name of Object.keys(defaults)) {",
    "      const v = params.get(name);",
    "      if (v !== null) out[name] = v;",
    "    }",
    "    return out;",
    "  }, [JSON.stringify(defaults)]);",
    "",
    "  const [values, setValues] = React.useState(read);",
    "  React.useEffect(() => {",
    "    const onPop = () => setValues(read());",
    "    window.addEventListener('popstate', onPop);",
    "    return () => window.removeEventListener('popstate', onPop);",
    "  }, [read]);",
    "",
    "  const set = React.useCallback((name: string, value: string) => {",
    "    const params = new URLSearchParams(window.location.search);",
    "    params.set(name, value);",
    "    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);",
    "    setValues((v) => ({ ...v, [name]: value }));",
    "  }, []);",
    "",
    "  return React.useMemo(() => ({ ...values, set }), [values, set]);",
    "}",
    "",
    "export type ActionState = { busy: boolean; error: string | null; fieldErrors: Record<string, string> };",
    "",
    "/** Submit to an action endpoint, with optional confirmation and field errors. */",
    "export function useAction(",
    "  path: string,",
    "  opts: { confirm?: string } = {},",
    "): ActionState & { run(input: unknown): Promise<boolean> } {",
    "  const [state, setState] = React.useState<ActionState>({",
    "    busy: false,",
    "    error: null,",
    "    fieldErrors: {},",
    "  });",
    "  const run = React.useCallback(",
    "    async (input: unknown): Promise<boolean> => {",
    "      if (opts.confirm !== undefined && !window.confirm(opts.confirm)) return false;",
    "      setState({ busy: true, error: null, fieldErrors: {} });",
    "      try {",
    "        const r = await fetch(path, {",
    "          method: 'POST',",
    "          headers: { 'content-type': 'application/json' },",
    "          body: JSON.stringify(input),",
    "        });",
    "        const body = (await r.json()) as",
    "          | { ok: true }",
    "          | { ok: false; fieldErrors?: Record<string, string> };",
    "        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);",
    "        if (body.ok) {",
    "          setState({ busy: false, error: null, fieldErrors: {} });",
    "          return true;",
    "        }",
    "        setState({ busy: false, error: null, fieldErrors: body.fieldErrors ?? {} });",
    "        return false;",
    "      } catch (e: unknown) {",
    "        setState({",
    "          busy: false,",
    "          error: e instanceof Error ? e.message : String(e),",
    "          fieldErrors: {},",
    "        });",
    "        return false;",
    "      }",
    "    },",
    "    [path, opts.confirm],",
    "  );",
    "  return { ...state, run };",
    "}",
  ]);
  return { name: "runtime.tsx", text: e.text(), map: e.map() };
}
```

- [ ] **Step 5: Implement `src/compile/emit/pages.ts`**

```ts
import type { PropValue, SectionSpec } from "../../schema/types.js";
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter, type SpecPath } from "./emitter.js";
import { HEADER, cap, rel, type EmittedFile } from "./types.js";

const PAGES_TYPE =
  "Record<string, React.ComponentType<{ params: Record<string, string> }>>";

function expr(value: PropValue): string {
  if (value.kind === "literal") return JSON.stringify(value.value);
  const ref = value.ref;
  switch (ref.kind) {
    case "data":
      return [`${ref.name}.value`, ...ref.path].join(".");
    case "actions":
      return `${ref.name}Action.run`;
    case "compute":
      return `compute.${ref.name}`;
    case "param":
      return `params.${ref.name}`;
    case "filter":
      return `filters.${ref.name}`;
  }
}

export function emitPages(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  const byModule = new Map<string, string[]>();
  for (const c of app.components) {
    byModule.set(c.module, [...(byModule.get(c.module) ?? []), c.name]);
  }

  e.line(HEADER);
  e.line('"use client";');
  e.line();
  e.line('import * as React from "react";');
  for (const module of [...byModule.keys()].sort()) {
    const names = [...new Set(byModule.get(module)!)].sort();
    e.line(`import { ${names.join(", ")} } from "${module}";`);
  }
  if (app.computes.length > 0) e.line(`import * as compute from "${rel(config, "../compute")}";`);
  e.line(`import { useAction, useFilters, useLoader } from "${rel(config, "./runtime")}";`);
  for (const name of app.loaders) {
    e.line(`import type { ${cap(name)} } from "${rel(config, "./types")}";`);
  }
  e.line();

  app.spec.pages.forEach((page, index) => {
    const path: SpecPath = ["pages", page.route];
    const used = usedLoaders(page.sections);
    const usedActions = usedActionNames(page.sections);

    e.line(`function Page_${index}({ params }: { params: Record<string, string> }) {`, path);
    e.indent();
    e.line("void params;");
    if (page.filters.length > 0) {
      const defaults = page.filters
        .map((f) => `${JSON.stringify(f.name)}: ${JSON.stringify(String(f.default ?? ""))}`)
        .join(", ");
      e.line(`const filters = useFilters({ ${defaults} });`);
    }
    const query =
      page.filters.length > 0
        ? `{ ${page.filters.map((f) => `${JSON.stringify(f.name)}: filters[${JSON.stringify(f.name)}]`).join(", ")} }`
        : "{}";
    for (const name of used) {
      e.line(
        `const ${name} = useLoader<${cap(name)}>("/_data/${name}", ${query});`,
      );
    }
    for (const name of usedActions) {
      e.line(`const ${name}Action = useAction("/_actions/${name}");`);
    }
    if (used.length > 0) {
      const anyError = used.map((n) => `${n}.error`).join(" ?? ");
      const anyLoading = used.map((n) => `${n}.loading`).join(" || ");
      e.line(`const error = ${anyError};`);
      e.line(`if (error) return <${config.states.error}>{error}</${config.states.error}>;`);
      e.line(`if (${anyLoading}) return <${config.states.loading} />;`);
    }
    e.line("return (");
    e.indent().line("<>");
    e.indent();
    page.sections.forEach((section, i) => {
      emitSection(section, [...path, "sections", i]);
    });
    e.dedent().line("</>").dedent();
    e.line(");");
    e.dedent();
    e.line("}");
    e.line();
  });

  e.line(`export const pages: ${PAGES_TYPE} = {`);
  e.indent();
  app.spec.pages.forEach((page, index) => {
    e.line(`${JSON.stringify(page.route)}: Page_${index},`, ["pages", page.route]);
  });
  e.dedent();
  e.line("};");

  return { name: "pages.tsx", text: e.text(), map: e.map() };

  function emitSection(section: SectionSpec, path: SpecPath): void {
    const name = section.component.name;
    const props = Object.keys(section.props)
      .sort()
      .map((p) => `${p}={${expr(section.props[p]!)}}`)
      .join(" ");
    const open = props === "" ? `<${name}` : `<${name} ${props}`;
    if (section.children.length === 0) {
      e.line(`${open} />`, path);
      return;
    }
    e.line(`${open}>`, path);
    e.indent();
    section.children.forEach((child, i) => emitSection(child, [...path, "children", i]));
    e.dedent();
    e.line(`</${name}>`, path);
  }
}

function usedLoaders(sections: SectionSpec[]): string[] {
  return collect(sections, "data");
}

function usedActionNames(sections: SectionSpec[]): string[] {
  return collect(sections, "actions");
}

function collect(sections: SectionSpec[], kind: "data" | "actions"): string[] {
  const found = new Set<string>();
  const walk = (list: SectionSpec[]) => {
    for (const s of list) {
      for (const value of Object.values(s.props)) {
        if (value.kind === "binding" && value.ref.kind === kind) found.add(value.ref.name);
      }
      walk(s.children);
    }
  };
  walk(sections);
  return [...found].sort();
}
```

- [ ] **Step 6: Implement `src/compile/emit/handlers.ts`**

```ts
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { HEADER, rel, type EmittedFile } from "./types.js";

const HANDLERS_TYPE =
  "Record<string, (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>>";

export function emitHandlers(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER).line();
  if (app.loaders.length > 0) e.line(`import * as data from "${rel(config, "../data")}";`);
  if (app.actions.length > 0) e.line(`import * as actions from "${rel(config, "../actions")}";`);
  e.line();
  e.line(`export const handlers: ${HANDLERS_TYPE} = {`);
  e.indent();
  for (const name of app.loaders) {
    e.line(`"GET /_data/${name}": async (req: Request): Promise<Response> => {`);
    e.indent();
    e.line("const url = new URL(req.url);");
    e.line("const input = Object.fromEntries(url.searchParams.entries());");
    e.line(`return Response.json(await data.${name}(input as never));`);
    e.dedent();
    e.line("},");
  }
  for (const name of app.actions) {
    e.line(`"POST /_actions/${name}": async (req: Request): Promise<Response> => {`);
    e.indent();
    e.line(`return Response.json(await actions.${name}((await req.json()) as never));`);
    e.dedent();
    e.line("},");
  }
  e.dedent();
  e.line("};");
  return { name: "handlers.ts", text: e.text(), map: e.map() };
}
```

- [ ] **Step 7: Implement `src/compile/emit/contract.ts`**

```ts
import type { NovaConfig } from "../config.js";
import type { ResolvedApp } from "../resolve.js";
import { Emitter } from "./emitter.js";
import { HEADER, cap, rel, type EmittedFile } from "./types.js";

export function emitContract(app: ResolvedApp, config: NovaConfig): EmittedFile {
  const e = new Emitter();
  e.line(HEADER);
  e.line("// Typechecked, never executed. Diagnostics here are remapped to the spec.");
  e.line();
  if (app.loaders.length > 0) e.line(`import * as data from "${rel(config, "../data")}";`);
  if (app.actions.length > 0) e.line(`import * as actions from "${rel(config, "../actions")}";`);
  const typeNames = [...app.loaders.flatMap((n) => [cap(n), `${cap(n)}Input`]), ...app.actions.map(cap)];
  if (typeNames.length > 0) {
    e.line(`import type { ${[...new Set(typeNames)].sort().join(", ")} } from "${rel(config, "./types")}";`);
  }
  e.line();
  for (const name of app.loaders) {
    e.line(
      `const _${name}: (input: ${cap(name)}Input) => Promise<${cap(name)}> = data.${name};`,
      ["loaders", name],
    );
    e.line(`void _${name};`);
  }
  for (const name of app.actions) {
    e.line(`const _${name}: ${cap(name)} = actions.${name};`, ["actions", name]);
    e.line(`void _${name};`);
  }
  return { name: "__contract.ts", text: e.text(), map: e.map() };
}
```

- [ ] **Step 8: Create `src/compile/emit/index.ts`**

```ts
export { Emitter } from "./emitter.js";
export type { LineMap, SpecPath } from "./emitter.js";
export { emitContract } from "./contract.js";
export { emitHandlers } from "./handlers.js";
export { emitPages } from "./pages.js";
export { emitRuntime } from "./runtime.js";
export { emitTypes, HEADER, cap, rel } from "./types.js";
export type { EmittedFile } from "./types.js";
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run test/emit.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 10: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/compile/emit test/emit.test.ts
git commit -m "feat: emit types, runtime, pages, handlers and contract"
```

---

### Task 10: Typechecking the emitted output and remapping diagnostics

**Files:**
- Create: `src/compile/typecheck.ts`
- Test: `test/typecheck.test.ts`

**Interfaces:**
- Consumes: `createProgram` from Task 5; `EmittedFile` and `LineMap` from Tasks 8–9; `Diagnostic`, `Position` from Task 1.
- Produces: `typecheckEmitted(opts: { files: EmittedFile[]; outDir: string; tsconfigPath: string; positions: PositionMap }): Diagnostic[]`.

This is where spec decision D5 pays off. TypeScript performs every assignability check on the emitted JSX and the contract file; nova's only job is to move the error's address. A diagnostic on a generated line with a known spec origin is reported at that spec position with code `NOVA3001`. One with no mapping keeps the generated location under `NOVA3002`, so nothing is ever silently swallowed.

- [ ] **Step 1: Write the failing test**

Create `test/typecheck.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Emitter } from "../src/compile/emit/emitter.js";
import type { EmittedFile } from "../src/compile/emit/types.js";
import type { PositionMap } from "../src/compile/load.js";
import { typecheckEmitted } from "../src/compile/typecheck.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const TSCONFIG = here("./fixtures/tsconfig.json");

const positions: PositionMap = {
  at: (path) => ({ file: "app.yaml", line: path.length === 0 ? 1 : 42, col: 3 }),
};

function scratch(files: EmittedFile[]): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-"));
  for (const f of files) writeFileSync(join(dir, f.name), f.text);
  return dir;
}

function file(name: string, lines: string[], origins: Record<number, (string | number)[]>): EmittedFile {
  const e = new Emitter();
  lines.forEach((l, i) => e.line(l, origins[i + 1]));
  return { name, text: e.text(), map: e.map() };
}

describe("typecheckEmitted", () => {
  it("reports nothing for well-typed output", () => {
    const f = file("ok.ts", ["export const n: number = 1;"], {});
    const dir = scratch([f]);
    expect(typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions })).toEqual([]);
  });

  it("remaps a type error to the spec position that produced the line", () => {
    const f = file("bad.ts", ["export const n: number = 1;", 'export const s: string = 2;'], {
      2: ["pages", "/", "sections", 0],
    });
    const dir = scratch([f]);
    const out = typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe("NOVA3001");
    expect(out[0]!.file).toBe("app.yaml");
    expect(out[0]!.line).toBe(42);
    expect(out[0]!.related?.[0]?.file).toContain("bad.ts");
  });

  it("keeps the generated location when a line has no spec origin", () => {
    const f = file("orphan.ts", ['export const s: string = 2;'], {});
    const dir = scratch([f]);
    const out = typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe("NOVA3002");
    expect(out[0]!.file).toContain("orphan.ts");
    expect(out[0]!.line).toBe(1);
  });

  it("reports every error rather than the first", () => {
    const f = file("many.ts", ['export const a: string = 1;', 'export const b: string = 2;'], {});
    const dir = scratch([f]);
    expect(typecheckEmitted({ files: [f], outDir: dir, tsconfigPath: TSCONFIG, positions })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/typecheck.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/typecheck.js'`.

- [ ] **Step 3: Implement `src/compile/typecheck.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/typecheck.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compile/typecheck.ts test/typecheck.test.ts
git commit -m "feat: typecheck emitted output and remap diagnostics to the spec"
```

---

### Task 11: `compileApp` end to end

**Files:**
- Create: `src/compile/index.ts`
- Test: `test/compile.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–10.
- Produces:
  - `CompileResult = { ok: boolean; diagnostics: Diagnostic[]; files: EmittedFile[]; written: string[] }`
  - `compileApp(appDir: string, config: NovaConfig, opts?: { write?: boolean }): Promise<CompileResult>`

Order: load → validate → catalogs → resolve → emit → write → typecheck. Each stage stops the pipeline if it produced an error, so a missing `sections` key never cascades into fifty type errors. `write: false` runs the whole pipeline in memory and returns the files without touching disk, which is what a `--check` mode uses.

A header comment in each emitted file carries a hash of the inputs, so a later run can skip work when nothing changed. The hash covers the spec source, the sorted catalog module list and the compiler version.

- [ ] **Step 1: Write the failing test**

Create `test/compile.test.ts`:

```ts
import { mkdtempSync, cpSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileApp } from "../src/compile/index.js";
import type { NovaConfig } from "../src/compile/config.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const dirs: string[] = [];
function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "nova-app-"));
  dirs.push(root);
  cpSync(here("./fixtures"), root, { recursive: true });
  return join(root, "app-basic");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.json"),
});

describe("compileApp", () => {
  it("compiles the fixture app and writes five files", async () => {
    const appDir = fixtureCopy();
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.name).sort()).toEqual([
      "__contract.ts",
      "handlers.ts",
      "pages.tsx",
      "runtime.tsx",
      "types.ts",
    ]);
    expect(readFileSync(join(appDir, "generated", "pages.tsx"), "utf8")).toContain("<Table");
  });

  it("is byte-deterministic across runs", async () => {
    const appDir = fixtureCopy();
    const a = await compileApp(appDir, configFor(appDir));
    const b = await compileApp(appDir, configFor(appDir));
    expect(a.files.map((f) => f.text)).toEqual(b.files.map((f) => f.text));
  });

  it("writes nothing when write is false", async () => {
    const appDir = fixtureCopy();
    const result = await compileApp(appDir, configFor(appDir), { write: false });
    expect(result.written).toEqual([]);
    expect(result.files.length).toBe(5);
    expect(() => readFileSync(join(appDir, "generated", "pages.tsx"), "utf8")).toThrow();
  });

  it("stops after validation errors without emitting", async () => {
    const appDir = fixtureCopy();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(appDir, "app.yaml"), 'pages:\n  "/":\n    titel: x\n    sections: []\n');
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA1001"]);
  });

  it("stops after resolution errors without emitting", async () => {
    const appDir = fixtureCopy();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(appDir, "app.yaml"), 'pages:\n  "/":\n    sections:\n      - Tabel: {}\n');
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NOVA2001"]);
  });

  it("reports a missing app.yaml rather than throwing", async () => {
    const appDir = fixtureCopy();
    rmSync(join(appDir, "app.yaml"));
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("NOVA1006");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/compile.test.ts`
Expected: FAIL — `Cannot find module '../src/compile/index.js'`.

- [ ] **Step 3: Implement `src/compile/index.ts`**

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagnostic, type Diagnostic } from "../schema/diagnostic.js";
import { validate } from "../schema/validate.js";
import { readCatalogs } from "./catalog.js";
import type { NovaConfig } from "./config.js";
import {
  emitContract,
  emitHandlers,
  emitPages,
  emitRuntime,
  emitTypes,
  type EmittedFile,
} from "./emit/index.js";
import { loadSpecFile } from "./load.js";
import { resolveApp } from "./resolve.js";
import { typecheckEmitted } from "./typecheck.js";

export type { NovaConfig } from "./config.js";
export type { EmittedFile } from "./emit/index.js";
export type { Diagnostic } from "../schema/diagnostic.js";

export type CompileResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  files: EmittedFile[];
  written: string[];
};

const VERSION = "0.0.0";

const fail = (diagnostics: Diagnostic[]): CompileResult => ({
  ok: false,
  diagnostics,
  files: [],
  written: [],
});

export async function compileApp(
  appDir: string,
  config: NovaConfig,
  opts: { write?: boolean } = {},
): Promise<CompileResult> {
  const write = opts.write ?? true;
  const specFile = join(appDir, "app.yaml");
  if (!existsSync(specFile)) {
    return fail([
      diagnostic("NOVA1006", "no app.yaml in this app folder", { file: specFile, line: 1, col: 1 }),
    ]);
  }

  const source = readFileSync(specFile, "utf8");
  const { raw, positions, diagnostics: loadDiags } = loadSpecFile(specFile, source);
  if (loadDiags.length > 0) return fail(loadDiags);

  const { spec, diagnostics: validateDiags } = validate(raw, positions);
  if (!spec) return fail(validateDiags);

  const { catalog, diagnostics: catalogDiags } = readCatalogs(config, specFile);
  if (catalogDiags.length > 0) return fail([...validateDiags, ...catalogDiags]);

  const { resolved, diagnostics: resolveDiags } = resolveApp(spec, {
    config,
    appDir,
    specFile,
    catalog,
    positions,
  });
  if (!resolved) return fail([...validateDiags, ...resolveDiags]);

  const hash = createHash("sha256")
    .update(source)
    .update(" ")
    .update([...config.components].sort().join(" "))
    .update(" ")
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
    emitPages(resolved, config),
    emitHandlers(resolved, config),
    emitContract(resolved, config),
  ]
    .map(stamp)
    .sort((a, b) => a.name.localeCompare(b.name));

  const outDir = join(appDir, config.outDir);
  const written: string[] = [];
  if (write) {
    mkdirSync(outDir, { recursive: true });
    for (const f of files) {
      const path = join(outDir, f.name);
      writeFileSync(path, f.text);
      written.push(path);
    }
  }

  const typeDiags = write
    ? typecheckEmitted({ files, outDir, tsconfigPath: config.tsconfigPath, positions })
    : [];

  const diagnostics = [...validateDiags, ...resolveDiags, ...typeDiags];
  return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics, files, written };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/compile.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Verify the full suite, typecheck and build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS. `dist/schema/index.js`, `dist/schema/index.d.ts`, `dist/compile/index.js` and `dist/compile/index.d.ts` all exist.

- [ ] **Step 6: Verify the generality constraint holds**

Run: `grep -rn "@platform/\|light\.inc\|getLightApi\|AppPages\|AppHandlers" src/ || echo "clean"`
Expected: `clean`. Spec §2 rule 1 — nova contains no host knowledge. If this ever prints a match, the design has been violated.

- [ ] **Step 7: Commit**

```bash
git add src/compile/index.ts test/compile.test.ts
git commit -m "feat: compileApp end to end"
```

---

### Task 12: Round-trip test that the emitted app actually typechecks

**Files:**
- Create: `test/roundtrip.test.ts`
- Modify: `test/fixtures/app-basic/app.yaml` (add an action-using page)
- Create: `test/fixtures/app-broken/app.yaml`, `test/fixtures/app-broken/data.ts`

**Interfaces:**
- Consumes: `compileApp` from Task 11.
- Produces: no new API. This task is the proof that the pieces compose.

The unit tests prove each stage in isolation. This proves the whole claim: a spec that binds a component prop to a loader whose type does not match produces a diagnostic pointing at the YAML line, and a correct spec produces output that typechecks clean.

- [ ] **Step 1: Extend the good fixture with an action**

Replace `test/fixtures/app-basic/app.yaml` with:

```yaml
pages:
  "/":
    title: Trips
    filters:
      month: { type: month, default: current }
    sections:
      - StatCard: { label: This month, value: data#monthlyTotal }
      - Table:
          rows: data#trips
          columns: [date, km]
          empty: No trips yet
  "/trip/:id":
    title: Trip
    sections:
      - StatCard: { label: Trip, value: params.id }
```

- [ ] **Step 2: Create the mismatched fixture**

`test/fixtures/app-broken/data.ts`:

```ts
/** Deliberately the wrong shape: Table wants an array of records, this is a number. */
export async function trips(input: { month: string }): Promise<number> {
  return input.month.length;
}
```

`test/fixtures/app-broken/app.yaml`:

```yaml
pages:
  "/":
    filters:
      month: { type: month, default: current }
    sections:
      - Table:
          rows: data#trips
          columns: [date]
```

- [ ] **Step 3: Write the failing test**

Create `test/roundtrip.test.ts`:

```ts
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../src/compile/config.js";
import { compileApp } from "../src/compile/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const dirs: string[] = [];

function app(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "nova-rt-"));
  dirs.push(root);
  cpSync(here("./fixtures"), root, { recursive: true });
  return join(root, name);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const configFor = (appDir: string): NovaConfig => ({
  components: ["../catalog/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: join(appDir, "..", "tsconfig.json"),
});

describe("round trip", () => {
  it("emits output that typechecks clean for a correct spec", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("emits a page per route", async () => {
    const appDir = app("app-basic");
    const result = await compileApp(appDir, configFor(appDir));
    const pages = result.files.find((f) => f.name === "pages.tsx")!.text;
    expect(pages).toContain('"/": Page_0,');
    expect(pages).toContain('"/trip/:id": Page_1,');
  });

  it("reports a prop/loader type mismatch at the YAML line, not the generated line", async () => {
    const appDir = app("app-broken");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.ok).toBe(false);
    const mismatch = result.diagnostics.find((d) => d.code === "NOVA3001");
    expect(mismatch).toBeDefined();
    expect(mismatch!.file).toBe(join(appDir, "app.yaml"));
    // The emitter maps whole JSX elements, so the origin is the `- Table:` section
    // node on line 6 — not the `rows:` line that supplied the offending prop.
    expect(mismatch!.line).toBe(6);
    expect(mismatch!.related?.[0]?.file).toContain("pages.tsx");
  });

  it("never leaves a diagnostic pointing only at generated code", async () => {
    const appDir = app("app-broken");
    const result = await compileApp(appDir, configFor(appDir));
    expect(result.diagnostics.filter((d) => d.code === "NOVA3002")).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run test/roundtrip.test.ts`
Expected: FAIL — the fixtures are new and at least the mismatch assertions fail.

- [ ] **Step 5: Fix whatever the round trip exposes**

This test is the first that exercises every stage against real TypeScript, so expect to adjust the emitters. Work through failures one at a time, re-running after each change.

The three most likely failures, in order:

1. **`NOVA3002` on `runtime.tsx` or `types.ts`.** Those files have no spec origin for any line, so any type error in them surfaces unmapped. Fix the emitted code, not the mapping — `runtime.tsx` must typecheck standalone under the fixture tsconfig, which has `"lib": ["ES2022", "DOM"]` for `window` and `fetch`.
2. **The `input as never` cast in `handlers.ts` hiding a real mismatch.** If a loader takes a non-string field, the cast lets it through at compile time and fails at runtime. If the round trip exposes this, narrow the cast to the loader's own `Parameters<>` type rather than widening the test.
3. **`useLoader<Trips>` failing when a loader returns a primitive** (as `app-broken`'s does). That is the mismatch the test is asserting on — confirm it reports `NOVA3001` at the spec, not that it compiles.

Do not weaken an assertion to make it pass. If `NOVA3002` appears, a generated line is missing an origin, and the fix belongs in the emitter that produced it.

Run after each change: `pnpm vitest run test/roundtrip.test.ts`
Expected: eventually PASS — 4 tests.

- [ ] **Step 6: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/roundtrip.test.ts test/fixtures
git commit -m "test: round-trip compile with type mismatch remapping"
```

---

### Task 13: README and release readiness

**Files:**
- Create: `README.md`
- Modify: `package.json` (add `prepublishOnly`)

**Interfaces:**
- Consumes: the public API from Tasks 1–11.
- Produces: no new API.

- [ ] **Step 1: Write `README.md`**

````markdown
# @light/nova

A build-time compiler that turns a declarative YAML description of an app's UI
into React pages and HTTP handlers.

Nova ships **no components and no runtime**. Components come from your own
codebase, and every type check is performed by your TypeScript, not
reimplemented. Generated code imports your catalogs, your app's files, and
React — never nova.

## Install

```bash
pnpm add -D @light/nova typescript
```

There is no root export. Import from a subpath:

```ts
import { compileApp } from "@light/nova/compile";
import type { AppSpec } from "@light/nova/schema";
```

## Use

```ts
import { compileApp } from "@light/nova/compile";

const result = await compileApp("apps/trips", {
  components: ["@acme/ui"],
  states: { loading: "Loading", error: "ErrorNotice", empty: "EmptyState" },
  outDir: "generated",
  tsconfigPath: "tsconfig.json",
});

for (const d of result.diagnostics) {
  console.error(`${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`);
}
process.exit(result.ok ? 0 : 1);
```

Nova never reads config from disk — you pass the value, so you can keep it in
whatever form your build already uses.

## What an app looks like

```
apps/trips/
├── app.yaml       the spec
├── data.ts        typed async loaders
├── actions.ts     typed mutations
└── generated/     emitted: pages.tsx, handlers.ts, types.ts, runtime.tsx, __contract.ts
```

```yaml
# app.yaml
pages:
  "/":
    title: Trips
    filters:
      month: { type: month, default: current }
    sections:
      - Table:
          rows: data#trips
          columns: [date, km]
          empty: No trips yet
```

```ts
// data.ts
export async function trips(input: { month: string }): Promise<Array<{ date: string; km: number }>> {
  // …
}
```

Components are resolved by name against the modules listed in `components`. A
bare capitalised name must be exported by one of them; a name that isn't
resolves to a build error listing what is available. Anything a spec can't
express is referenced by path instead — `./views/charts#BridgeChart` — and still
gets its props typechecked.

## Diagnostics

Codes are stable. `NOVA1xxx` is the spec file itself, `NOVA2xxx` is name
resolution, `NOVA3xxx` is a type error in emitted output remapped back to the
YAML line that caused it.

## Requirements

Node ≥ 20, TypeScript ≥ 5.5 (a peer dependency — nova uses yours, so its answers
match your own `tsc`).
````

- [ ] **Step 2: Add a publish guard to `package.json`**

Add to `"scripts"`:

```json
"prepublishOnly": "pnpm test && pnpm typecheck && pnpm build"
```

- [ ] **Step 3: Verify the packed contents**

Run: `pnpm pack --dry-run`
Expected: the file list contains `dist/**` and `README.md`, and does **not** contain `src/`, `test/` or `docs/`.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "docs: README and publish guard"
```

---

## What this plan does not cover

Deliberately out of scope, each needing its own plan:

- **external-apps integration** — `nova.config.ts`, the `build-registry` wiring, the ESLint allowlist change, and the catalog lint rule. Spec §8.
- **`packages/ui` components** — `Table`, filter bar and form field do not exist yet and are a prerequisite for converting any real app. Spec §8 item 2. Independent of nova; can proceed in parallel.
- **Converting `german-mileage`** — spec §11 step 7, and the thing that will most sharpen the spec vocabulary.
- **Publishing** — confirming the `@light` npm scope is owned before the first `npm publish`. Spec §12.
- **Incremental skipping.** Task 11 stamps the input hash into each emitted header, which is what spec §7.4 requires to make skipping possible, but nothing yet *reads* it to skip work. Add it once compile times on a real app justify it — the stage that costs anything is the `ts.Program` boot in Task 10.
