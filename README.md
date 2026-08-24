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
  states: { loading: "Loading", error: "ErrorNotice" },
  outDir: "generated",
  tsconfigPath: "tsconfig.json",
  basePath: "/api/apps/trips",
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

`basePath` is optional and defaults to `""`. It is the path your host mounts this
app's handler map at, and it prefixes the URLs the generated client fetches:
`"/api/apps/trips"` turns `fetch("/_data/trips")` into
`fetch("/api/apps/trips/_data/trips")`. The **keys of `handlers`** deliberately do
not move with it — they are matched against the remainder of the path *after* your
mount, so prefixing both halves would double the prefix. Leave `basePath` unset for
a host that serves apps from the site root.

`states.loading` and `states.error` are required and `states.empty` is optional; see
[what nova renders itself](#what-nova-renders-itself).

### Compiling more than one app

Every app's compile builds a few `ts.Program`s, and most of what they parse —
the lib files, `@types/*`, your component catalog — is the same for all of them.
Pass one session to every call and that work happens once:

```ts
import { compileApp, createSession } from "@light/nova/compile";

const session = createSession();
for (const app of apps) {
  const result = await compileApp(app, config, { session });
  // ...
}
```

Results are identical either way; a session only removes repeated work. On a
38-app repo with a repository-wide tsconfig `include`, sharing one took the
build from 65s to 3.3s and peak memory from 2.3GB to 0.7GB. Every cached entry
is revalidated against the file's modification time and size, so a session is
safe to hold across rebuilds in a watch loop. The one thing it will not notice
is a *new* file appearing under the tsconfig's `include` while the tsconfig
itself is unchanged — call `createSession()` again if that can happen.

## What an app looks like

```
apps/trips/
├── app.yaml       the spec
├── data.ts        typed async loaders
├── actions.ts     typed mutations
└── generated/     emitted: pages.tsx, views.tsx, handlers.ts, types.ts, runtime.tsx, __contract.ts
```

`pages.tsx` exports two maps: `pages`, keyed by route, and `titles`, carrying each
page's `title:`. Nova ships no shell component and `states` names only the loading and
error components, so there is nowhere in a generated page for a title to go —
the host mounts `titles` wherever its own layout puts one, exactly as it mounts `pages`.

`pages.tsx` and `views.tsx` are one module split in two, and the split is load-bearing
under React Server Components. `views.tsx` carries `"use client"` and exports one
component per route (`Page_0`, `Page_1`, …); `pages.tsx` carries **no** directive and
imports them. A server module that imports a `"use client"` module receives *client
references* rather than values, so a route map exported from the client half reads back
as `{}` — the host matches no route and 404s with nothing to show for it. Mount `pages`
and `titles` from `pages.tsx`; nothing needs to import `views.tsx` directly.

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
and `error` to each field, so a catalog's field components must accept those — the exact
shapes are in [what nova renders itself](#what-nova-renders-itself). `name` and any other
prop you write are forwarded as usual. A spec that also sets one of the supplied props is
`NOVA1001` rather than a silent override.

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

`refreshes:` names the loaders a successful action invalidates, so the saved row appears
without a reload:

```yaml
- Form: { submit: actions#saveTrip, refreshes: [trips], fields: [ … ] }
```

Each name is resolved against the loaders that page's own sections bind, so
`refreshes: [tirps]` is `NOVA1012` at that line rather than a page that silently never
refreshes. It attaches to the one action the section runs — `NOVA1007` if there is not
exactly one, exactly as `confirm:` — and runs only when the action reports `ok: true`; an
action that came back with `fieldErrors` changed nothing. There is no cache and no key
space behind it: it calls `reload()` on each named loader, and the loader re-requests.

Components are resolved by name against the modules listed in `components`. A
bare capitalised name must be exported by one of them; a name that isn't
resolves to a build error listing what is available. Anything a spec can't
express is referenced by path instead — `./views/charts#BridgeChart` — and still
gets its props typechecked.

## What nova renders itself

Every component in a generated page is yours, but a few of them nova constructs rather
than forwards a spec's props to, so their shapes are a contract. A component that does
not match is a `NOVA3001` on every use, which is a poor way to discover it.

| Where | What nova writes | What your component must declare |
| --- | --- | --- |
| `states.loading` | `<Loading />` | every prop optional — it is given none at all |
| `states.error` | `<ErrorNotice>{message}</ErrorNotice>` | `children` — the message is not a prop |
| a form shell (`submit:`) | `busy`, `error`, `onSubmit`, its fields as children | `busy: boolean`, `error: string \| null`, `onSubmit: () => Promise<boolean>`, `children` |
| a field (`fields:`) | `value`, `onChange`, `error`, **and `name`** | `name: string`, `value`/`onChange` at that input key's own type, `error?: string` |
| a sortable section (`sortable:`) | `sort`, `onSort`, and `sortable` itself | `sort: { column: string; direction: "asc" \| "desc" } \| null`, `onSort: (column: string) => void`, `sortable: string[]` |

A field's `name` is both the wiring and an ordinary prop: nova uses it as the key of the
action's input **and** forwards it, because a field almost always wants it for its
label's `htmlFor`. That is deliberate, so declare `name: string` on every field
component. The keys nova consumes and does *not* forward are `initial:`, `confirm:` and
`refreshes:`.

`states.empty` is optional and no generated page renders it. A section knows whether its
own rows are empty and nova does not, so the empty state belongs to your table — as an
ordinary `empty:` prop of it. Where `states.empty` is given it is still resolved against
the catalog, so a name that does not exist is still a build error; that is the whole of
what it does.

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
  unknown or missing keys). `NOVA1007` is a `confirm:` or `refreshes:` with other
  than exactly one action to attach to; `NOVA1008` two fields editing the same key;
  `NOVA1009` a sortable column the section's own `columns:` list does not have;
  `NOVA1010` one page binding the same action in two ways nova cannot reconcile
  (two different `confirm:` messages or `refreshes:` lists, or two forms on one
  action); `NOVA1011` more than one sortable section on a page; `NOVA1012` a
  `refreshes:` naming a loader that page's own sections do not bind — the next
  free number in the block, and a spec-file problem like the rest of it, since it
  is answered from the page's own text with no catalog or type information.
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

**Ambient declarations must live in a `.d.ts`.** Nova's programs are built
from the files it needs plus whatever those import — TypeScript follows the
imports itself — so a tsconfig's `include` set is not dragged in wholesale.
The exception is ambient declaration files, which nothing imports and which
therefore have to be roots: every `.d.ts` matched by `include` is added to
every program, so globals, JSX namespace types and module augmentations work
as they do under your own `tsc`. Ambient declarations written in a plain
non-module `.ts` file rather than a `.d.ts` are not picked up.

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
value (so a change to `states`, `outDir`, `importExtension`, `basePath` or
`tsconfigPath` changes the stamp too) and the compiler version. It does not
cover the contents of `data.ts`, `actions.ts`, `compute.ts`, or any catalog or
local component file, so it is not yet sufficient on its own to safely skip
recompilation when only those change.

## Requirements

Node ≥ 20, TypeScript ≥ 5.5 (a peer dependency — nova uses yours, so its answers
match your own `tsc`).
