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

`./compile` is the whole pipeline and loads TypeScript. `./schema` is the spec format on
its own — types, `validate`, and nothing that pulls in a compiler or a YAML parser.

To check a spec without compiling it, use `parseSpec` from `./compile`: it parses the
YAML, validates the shape, and reports `NOVA1xxx` with real line and column numbers. It
reads no catalogs, resolves no names and emits nothing.

```ts
import { parseSpec } from "@light/nova/compile";

const { spec, diagnostics } = parseSpec("apps/trips/app.yaml", source);
```

`./schema`'s `validate(raw, positions)` is the same check without the YAML dependency —
for a consumer that already holds a parsed document. `positions` maps a path inside the
document to a source position; `loadSpecFile` (exported from `./compile`) builds a
precise one from the YAML, and `atFile(file)` (exported from `./schema`) is the
dependency-free fallback that pins every diagnostic to the top of the named file.

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
whatever form your build already uses. `components`, `states`, `outDir` and
`tsconfigPath` are all required; `importExtension` is optional and defaults to
bundler-style resolution (no extension appended to relative imports).

## What an app looks like

```
apps/trips/
├── app.yaml       the spec
├── data.ts        typed async loaders
├── actions.ts     typed mutations
└── generated/     emitted: pages.tsx, handlers.ts, types.ts, runtime.tsx, __contract.ts
```

`pages.tsx` exports two maps: `pages`, keyed by route, and `titles`, carrying each
page's `title:`. Nova ships no shell component and `states` names only the loading,
error and empty components, so there is nowhere in a generated page for a title to go —
the host mounts `titles` wherever its own layout puts one, exactly as it mounts `pages`.

A filter is a name and an optional `default`. The value is kept in the query string, so
a refresh preserves it, and it feeds the input object of every loader on the page.
`default` is a plain literal: there is no widget vocabulary and no computed sentinel, so
`default: current` would ship the string `"current"` rather than the current month.

```yaml
# app.yaml
pages:
  "/":
    title: Trips
    filters:
      month: { default: "2026-08" }
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

## Loader inputs

A loader's input object is assembled from the page's route params and its filter
values, and is checked against the loader's own declared parameter type. If a loader
declares `{ month: string; region: string }` and the page supplies neither, that is a
`NOVA3001` at the spec line that named the loader — not a generated call that fails at
runtime. Where a route param and a filter share a name, the route param wins.

Generated code is safe under `noUncheckedIndexedAccess`. Filter values are keyed by
the filter names the page declares rather than by an open index signature, and each
route param a page reads is narrowed into a local once at the top of the page function.

## Diagnostics

Codes are stable.

- `NOVA1xxx` — a problem in the spec file itself (YAML syntax, schema shape,
  unknown or missing keys).
- `NOVA2xxx` — name resolution: an unknown component, a missing catalog
  module, a `data.ts`/`actions.ts`/`compute.ts` export that doesn't exist, or
  a filter/route parameter reference that doesn't match its page.
- `NOVA3xxx` — a problem TypeScript found in the emitted output. `NOVA3001` is
  remapped back to the YAML line that produced it; `NOVA3002` is reported at
  the generated location instead, because it has no traceable spec origin —
  that shape covers not only type errors but also syntactic problems in the
  generated code (for example malformed output from a bad template edge
  case). `NOVA3002` on its own is a signal of a nova bug, not a problem with
  your spec.

## Limitations

**Class components are not recognised.** Nova detects a component by checking
whether its export has a call signature. A class export has a construct
signature instead, so a class-based component is filtered out of the catalog
before name resolution ever sees it — referencing it by name produces the
same "unknown component" error as a typo, even though it is exported. Function
components and `forwardRef` components both have call signatures and work as
expected.

**`write: false` performs no typecheck.** Passing `write: false` to
`compileApp` still runs the full pipeline in memory and returns the files
that would be emitted, but nothing is written to disk, so there is nothing
there for TypeScript to check — the typecheck stage is skipped entirely.
`result.ok === true` under `write: false` means the spec resolved and emitted
successfully; it is not a claim that the emitted output type-checks. Only a
`write: true` run (the default) verifies that.

**`typecheckEmitted` covers only the spec-to-code seam.** It reports
diagnostics on the files nova emits, not on the app's own hand-written
modules or on host catalog components — those already go through the host's
own `tsc`, editor, and CI, and duplicating that here would just be noise. An
empty diagnostics array means the seam between the spec and your code is
clean; it does not mean the overall build is clean. That seam check lives in
`pages.tsx`: its JSX binds every prop to the component and loader/action type
the spec references, so a mismatch is real React JSX typing, not a
comparator nova maintains. `__contract.ts` is a narrower, additional check —
its `XxxInput`/`Xxx` types are derived from the very loader/action they are
assigned back to, so it cannot catch a spec/code type mismatch (`pages.tsx`
already does); it catches loader arity and a loader that isn't declared
`async`, which `pages.tsx`'s JSX has no occasion to exercise.

**`confirm:` is not implemented.** The spec format and `useAction`'s runtime
support a confirmation prompt before a destructive action (`opts.confirm`,
plumbed through to `window.confirm`), but there is currently no schema key
that sets it — `validate` has no `confirm:` handling, so nothing in a spec can
populate `opts.confirm` yet.

**`fieldErrors` and the empty state are not consumed by any generated page.**
`useAction`'s `ActionState` carries `fieldErrors`, and `states.empty` is
validated against the catalog on every compile, but no generated `pages.tsx`
currently renders either one: no emitted form wires a returned field error
back onto its input, and the empty state component is never rendered even
when a loader's result is empty. Both are real, typechecked runtime/catalog
surface — just not yet reached by codegen.

**The input hash does not cover source file contents.** The stamp written
into each emitted file's header covers the spec source, the whole config
value (so a change to `states`, `outDir`, `importExtension` or
`tsconfigPath` changes the stamp too) and the compiler version. It does not
cover the contents of `data.ts`, `actions.ts`, `compute.ts`, or any catalog or
local component file, so it is not yet sufficient on its own to safely skip
recompilation when only those change.

## Requirements

Node ≥ 20, TypeScript ≥ 5.5 (a peer dependency — nova uses yours, so its answers
match your own `tsc`).
