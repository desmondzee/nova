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

## Forms

A section that carries `submit:` is a form. Its `fields:` each name a key of the
action's input type, and that is checked by TypeScript rather than by nova:

```yaml
- Form:
    submit: actions#saveTrip
    confirm: Save this trip?
    fields:
      - DateField:   { name: date,    label: Date }
      - NumberField: { name: km,      label: "Distance (km)", initial: 0 }
      - TextField:   { name: purpose, label: Purpose }
```

```ts
// actions.ts
export interface TripInput { date: string; km: number; purpose: string }

export async function saveTrip(input: TripInput):
  Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> { … }
```

The page holds the form in `useForm<SaveTripInput>`, where `SaveTripInput` is
`Parameters<typeof actions.saveTrip>[0]` — the same derived-type approach loader inputs
use. Each field emits `values["km"]`, `set("km", value)` and `errors["km"]` against it, so
three things are compile errors at the spec line rather than runtime surprises:

- **a field naming a key the action does not accept**, reported on that field's own line;
- **a field whose value type does not match the key's** — a `NumberField` on a `string`
  key — because `onChange`'s parameter type comes from the component and `set`'s from the
  action;
- **a form that does not cover every required key of the input**, reported on the
  `- Form:` line, because the field list is what assembles `useForm`'s initial values. A
  form is checked for completeness, not only for correctness.

`initial:` on a field is its starting value, defaulting to `""`. A `NumberField` that does
not say `initial: 0` gets a type error at the form, which is the right place to be told.

Nova supplies `onSubmit`, `busy` and `error` to the form component and `value`, `onChange`
and `error` to each field, so a catalog's field components must accept those. `name` and
any other prop you write are forwarded as usual. A spec that also sets one of the supplied
props is `NOVA1001` rather than a silent override.

`fieldErrors` returned by the action land on the matching field automatically.

## Confirmation, filter writes and sorting

`confirm:` on a section guards the one action that section runs, whether through
`submit:` or through an ordinary prop binding:

```yaml
- DeleteButton: { label: Delete, onSubmit: actions#deleteTrip, confirm: Delete this trip? }
```

It is consumed by nova rather than forwarded, so a delete button needs no `confirm` prop
of its own. A page hoists one `useAction` per action, so two sections asking for different
text on the same action is `NOVA1010`; a `confirm:` with no action to guard, or with more
than one, is `NOVA1007`.

`filters.month.set` is a filter reference in write mode. It emits
`(value: string) => filters.set("month", value)`, which updates the query string and the
page together:

```yaml
- FilterBar: { label: Month, value: filters.month, onChange: filters.month.set }
```

`sortable:` marks which of a section's columns the reader may sort by. Nova owns the sort
state and its round trip through the URL — `?sort=` and `?dir=`, beside the filters — and
hands the component `sort` and `onSort`; ordering the rows is the component's own job.

```yaml
- Table: { rows: data#trips, columns: [date, km], sortable: [date, km] }
```

A page holds one sort state, so a second sortable section is `NOVA1011`. A sortable column
outside the section's own literal `columns:` list is `NOVA1009`.

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
  unknown or missing keys). `NOVA1007` is a `confirm:` with other than exactly
  one action to guard; `NOVA1008` two fields editing the same key; `NOVA1009` a
  sortable column the section's own `columns:` list does not have; `NOVA1010`
  one page binding the same action in two ways nova cannot reconcile (two
  different `confirm:` messages, or two forms on one action); `NOVA1011` more
  than one sortable section on a page.
- `NOVA2xxx` — name resolution: an unknown component, a missing catalog
  module, a `data.ts`/`actions.ts`/`compute.ts` export that doesn't exist, a
  filter/route parameter reference that doesn't match its page, or one name
  bound to two different things (`NOVA2009` — two components, or a loader and
  an action sharing a name).
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

**A form's starting values are literals, applied once.** `initial:` on a field
takes a literal, so a form cannot be prefilled from a loader — an edit form
that opens on an existing record is not yet expressible. `useForm` seeds its
state on first render and does not re-seed, which is right for the entry forms
the format targets and wrong for a form whose starting values arrive later.

**A form cannot bind an optional key of the action's input.** `values["note"]`
for `note?: string` is `string | undefined`, so a field component declaring
`value: string` will not accept it. Either the field component accepts
`undefined` or the action declares the key required.

**One sort state and one form per action, per page.** Sort state lives under
`?sort=`/`?dir=`, so a page holds exactly one (`NOVA1011`), and a form's local
is named after its action, so one page cannot hold two forms on the same action
(`NOVA1010`). Neither is a limit of the URL or of React — both are places where
nova reports rather than guesses.

**The empty state is validated but never rendered.** `states.empty` is
required config and is checked against the catalog on every compile, but no
generated page renders it, even when a loader's result is empty. The
loading and error states are rendered; the empty one is not.

**Loading is inferred from `value === null`, not from `state.loading`.** A
page shows its loading component while any of its loaders has a null value.
A loader that legitimately resolves to `null` — `Promise<Trip | null>`, an
ordinary signature — therefore pins the page on the loading state. The
`loading` flag `useLoader` maintains is not read by any generated page.

**Loading and error states are page-level, not per binding.** One slow
loader blanks the whole page, and one failing loader replaces it with the
error component. Per-binding states are not expressible.

**The handler-to-loader boundary is not typechecked.** `handlers.ts` hands
URL search params (and, for an action, the parsed JSON body) to your function
through `as never`. That is the one place an untyped external value meets a
typed signature, and nothing checks it: a loader narrowed to
`input: { status: "open" | "closed" }` compiles even though a request can
supply any string. Validate inputs inside the loader if the distinction
matters.

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
