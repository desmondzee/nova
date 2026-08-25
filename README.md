# @desmondzee/nova

A build-time compiler that turns a declarative YAML description of an app's UI
into React pages and HTTP handlers.

Nova ships **no components and no runtime**. Components come from your own
codebase, and every type check is performed by your TypeScript, not
reimplemented. Generated code imports your catalogs, your app's files, and
React — never nova.

## Install

```bash
pnpm add -D @desmondzee/nova typescript
```

There is no root export. Import from a subpath:

```ts
import { compileApp } from "@desmondzee/nova/compile";
import type { AppSpec } from "@desmondzee/nova/schema";
```

`./compile` is the whole pipeline and loads TypeScript. `./schema` is the spec format on
its own — types, `validate`, and nothing that pulls in a compiler or a YAML parser.

To check a spec without compiling it, use `parseSpec` from `./compile`: it parses the
YAML, validates the shape, and reports `NOVA1xxx` with real line and column numbers. It
reads no catalogs, resolves no names and emits nothing.

```ts
import { parseSpec } from "@desmondzee/nova/compile";

const { spec, diagnostics } = parseSpec("apps/trips/app.yaml", source);
```

`./schema`'s `validate(raw, positions)` is the same check without the YAML dependency —
for a consumer that already holds a parsed document. `positions` maps a path inside the
document to a source position; `loadSpecFile` (exported from `./compile`) builds a
precise one from the YAML, and `atFile(file)` (exported from `./schema`) is the
dependency-free fallback that pins every diagnostic to the top of the named file.

## Use

```ts
import { compileApp } from "@desmondzee/nova/compile";

const result = await compileApp("apps/trips", {
  components: ["@acme/ui"],
  states: { loading: "Loading", error: "ErrorNotice" },
  shell: "PageShell",
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

`shell` is optional and names the component every page is wrapped in — **the one place
spacing and structure between top-level sections belongs**. Nova hands it the page's
`title:` and the sections as `children`:

```tsx
<PageShell title={"Trips"}>
  <FilterBar … />
  <Table … />
</PageShell>
```

It wraps the loading and error states too, so a page's own chrome does not vanish while
it loads. Without it a page's sections emit into a bare `<></>` — which is what they did
before shells existed, so leaving `shell` unset changes nothing. The cost of leaving it
unset is that vertical rhythm has nowhere to live but inside each component (a
`mt-4 first:mt-0` on every section-level component), which is a layout concern pushed
into components and a convention every host would otherwise invent for itself.

### Compiling more than one app

Every app's compile builds a few `ts.Program`s, and most of what they parse —
the lib files, `@types/*`, your component catalog — is the same for all of them.
Pass one session to every call and that work happens once:

```ts
import { compileApp, createSession } from "@desmondzee/nova/compile";

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

`pages.tsx` exports one map: `pages`, keyed by route. It used to export a second one,
`titles`, because a page's `title:` had nowhere to go; `shell` is that somewhere now, so
the map is gone rather than kept as an unused second route to the same string.

`pages.tsx` and `views.tsx` are one module split in two, and the split is load-bearing
under React Server Components. `views.tsx` carries `"use client"` and exports one
component per route (`Page_0`, `Page_1`, …); `pages.tsx` carries **no** directive and
imports them. A server module that imports a `"use client"` module receives *client
references* rather than values, so a route map exported from the client half reads back
as `{}` — the host matches no route and 404s with nothing to show for it. Mount `pages`
from `pages.tsx`; nothing needs to import `views.tsx` directly.

A filter is a name and an optional `default`. The value is kept in the query string, so
a refresh preserves it, and it feeds the input object of every loader on the page.
`default` is a literal, **or a `compute#` binding nova calls for the value**:

```yaml
filters:
  month: { default: compute#currentMonth }   # opens on the current month
```

```ts
// compute.ts
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
```

which emits `useFilters({ "month": compute.currentMonth() })`. A binding rather than a
magic string: `default: current` would be an untyped, host-specific vocabulary that only
ever grows, whereas a binding reuses the machinery every other reference uses, keeps time
handling in your code, and is checked — a `currentMonth` returning a `number` is a type
error at the page's own `filters:` block, because a filter value is a `string`. Only
`compute#` is accepted; any other namespace is `NOVA1013`, since a `data#` value is
asynchronous and arrives after the filter has already fed its own loader, and
`params.`/`filters.` are page state that does not exist yet when a default is needed.

**A computed default is evaluated during render, on the server as well as in the
browser.** Keep it a pure function of the clock and nothing else; two processes in
different time zones, or a render that straddles midnight on the 1st, can disagree, and
the client's answer is the one that survives. The value is a seed in either case: the
effect that adopts the query string still overwrites it whenever the URL carries one.

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

### Binding a union-typed key

An action whose input narrows a key — `vehicle: "car" | "van"` — needs a field component
that can carry that type. `onChange`'s parameter type comes from the component, so a
picker declaring `onChange(value: string): void` cannot be bound to it: `string` is not
assignable to the union, and rightly so, since such a picker may emit `"lorry"`. **Write
the field component generic in the value it carries**:

```tsx
export function ChoiceField<T extends string>(props: {
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  error?: string;
}): React.ReactElement { … }
```

Nova emits the same unannotated lambda it always did — `(value) => form.set("vehicle", value)`
— and **writes the type argument itself**:

```tsx
<ChoiceField<SaveTripInput["vehicle"]> value={…} onChange={(value) => …} … />
```

This supersedes the earlier rule that a catalog component's props type must be
non-generic; a generic *value* type is the mechanism that keeps the binding checked, so
forbidding it only forced hosts to widen the action's own input to `string` and narrow
inside it, losing exactly the guarantee this project exists to provide. But leaving the
type parameter to inference was not enough on its own: a parameter that none of the props
nova supplies mentions is inferred from nothing, resolves to its constraint, and every
type derived from it — `BooleanKeys<T>`, `Record<T, string>` — quietly stops constraining
anything. Writing the one type nova does know closes that.

The rule it fixes, and the one thing to know when writing a field component: **a generic
field component is generic in the value it carries.** Its first type parameter is the
type of the key it edits; a component generic in something else — the whole record, a set
of keys — will be handed a type argument it cannot accept, which is a `NOVA3001` at that
field's line. A component wanting *two* type arguments is `NOVA2012`, because nova has
one to give and a parameter left to inference is a parameter whose constraints may not
apply. Give the extras defaults, or wrap the component.

Nothing is cast, so nothing is silenced. What it catches:

| Spec | Diagnostic |
| --- | --- |
| an option outside the union (`{ value: lorry }`) | `NOVA3001` at the field's line: `'"lorry"' is not assignable to '"car" \| "van"'` |
| a plain `string` picker on the union key | `NOVA3001` at the field's line: `'string' is not assignable to '"car" \| "van"'` |
| a generic field whose parameter is not the value type | `NOVA3001` at the field's line — the type argument does not satisfy its constraint |
| a generic field wanting two type arguments | `NOVA2012` at the field's line |
| a `NumberField` on a `string` key | unchanged — the component's own `onChange` still decides |
| a `name:` the action does not accept | unchanged |

The constraint (`T extends string` above) is what keeps the literal types from widening
during inference, so declare one rather than a bare `<T>`.

A **section** component may be generic too, and there nova has no type argument to give —
its parameter is resolved by ordinary inference from the props the spec binds. That works
and is worth using where the parameter is reachable from a bound prop (`rows: data#trips`
fixing a table's row type); it does *not* work where the parameter appears only in a
mapped or conditional prop type, and there the constraint is vacuous with nothing to say
so. See [limitations](#limitations).

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

**An `actions#` binding on an ordinary prop is checked against the action's own input
type.** It reaches the component as `deleteTripAction.run`, and the page hoists that as
`useAction<DeleteTripInput>(…)`, so `run` is `(input: DeleteTripInput) => Promise<boolean>`
— accepted only by a prop whose callback hands it something the action takes:

```yaml
- ActivityList: { rows: data#trips, onDelete: actions#deleteTrip }
```

```tsx
// onDelete's parameter is what decides. `Trip` must be assignable to DeleteTripInput.
export function ActivityList(props: {
  rows: readonly Trip[];
  onDelete: (row: Trip) => Promise<boolean>;
}): React.ReactElement { … }
```

A component shared by several actions declares the payload it carries and is generic in
it — `payload: T; onDelete: (input: T) => Promise<boolean>` — so the action and the data
the component was given have to agree. A mismatch is `NOVA3001` at the section's own
line. Before, `run` was `(input: unknown) => Promise<boolean>`, and an `unknown`
parameter is assignable to *every* callback shape there is, so nothing about the payload
of an action outside a form was ever checked.

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
| `shell` | `<PageShell title={"Trips"}>` … `</PageShell>` around the page | `title?: string` (omitted for a page with no `title:`) and `children` |
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
  is answered from the page's own text with no catalog or type information;
  `NOVA1013` a filter `default:` bound to a namespace other than `compute#` — the
  next free number after it, and in this block for the same reason: whether
  `data#trips` may be a default is answered by the spec's own text, before any
  catalog is read.
- `NOVA2xxx` — name resolution: an unknown component, a missing catalog
  module, a `data.ts`/`actions.ts`/`compute.ts` export that doesn't exist, a
  filter/route parameter reference that doesn't match its page, or one name
  bound to two different things (`NOVA2009` — two components, or a loader and
  an action sharing a name). `NOVA2012` is a field component asking for more
  than one type argument — the next free number in the block, and in this
  block because it is answered by reading the catalog export's own type
  parameters, before anything is emitted. Nova has exactly one type argument
  for a field (the type of the input key it edits) and a parameter left to
  inference is a parameter whose constraints may silently stop applying, so
  it is reported rather than emitted half-instantiated.
- `NOVA3xxx` — a problem TypeScript found in the emitted output. `NOVA3001` is
  remapped back to the YAML line that produced it; `NOVA3002` is reported at
  the generated location instead, because it has no traceable spec origin —
  that shape covers not only type errors but also syntactic problems in the
  generated code (for example malformed output from a bad template edge
  case). `NOVA3002` on its own is a signal of a nova bug, not a problem with
  your spec.

## Breaking changes

### Since 0.1.0 — two type holes closed

Both change what the emitted output *asks of a host catalog*, so both can turn a build
that passed into one that reports. Neither touches any YAML: no spec changes.

- **An `actions#` binding on an ordinary prop is now checked against the action's input
  type.** `useAction` is generic (`useAction<Input>`) and its `run` is
  `(input: Input) => Promise<boolean>` rather than `(input: unknown) => …`. **What a host
  must do:** every component prop an `actions#` binding is bound to has to declare a
  callback the action can be handed. A prop declared `(input: unknown) => Promise<boolean>`
  — which is what an unchecked binding invited — now fails, because `unknown` is not
  assignable to the action's input. Replace it with the action's real input type, or, for
  a catalog component several apps share, make the component generic in the payload it
  already carries:

  ```diff
  -export type DestructiveActionProps = {
  -  send: unknown;
  -  onSubmit: (input: unknown) => Promise<boolean>;
  -};
  -export function DestructiveAction(props: DestructiveActionProps) { … }
  +export type DestructiveActionProps<T> = {
  +  send: T;
  +  onSubmit: (input: T) => Promise<boolean>;
  +};
  +export function DestructiveAction<T>(props: DestructiveActionProps<T>) { … }
  ```

  `T` is then inferred from the payload prop the spec already binds (usually from a
  loader), and the action bound beside it has to accept it. The reference consumer needed
  this in six places in one catalog; its other app, which binds no action outside a form,
  needed nothing.

- **A generic field component is now invoked with an explicit type argument** — the type
  of the action-input key it edits. **What a host must do:** a field component's first
  type parameter must be the type of the value it carries, and it must not need a second
  (`NOVA2012`). A field generic in something else — the record, a set of keys — has to
  grow a default for that parameter or move behind a non-generic wrapper. A field generic
  in its value type (`ChoiceField<T extends string>`) needs no change.

Recommended version for these: **0.2.0**. Note that the input stamp in each emitted
file's header covers the compiler *version*, not its build, so a host that skips
recompilation on an unchanged stamp should force one rebuild across the upgrade.

### In 0.1.0

Two, both from giving `title:` and `default:` somewhere real to go. Neither affects a
host that only mounts `pages` and writes literal filter defaults — the reference
consumer needed no edit to its spec, its catalog or its build.

- **`pages.tsx` no longer exports `titles`.** A host that mounts it must stop: configure
  `shell` and render the title there instead. The map existed only because nova had
  nowhere to put a title, and it was emitted into every app whether or not anything read
  it.
- **`FilterSpec["default"]` is a `PropValue`, not `unknown`.** Only a consumer of
  `@desmondzee/nova/schema` that inspects a parsed spec is affected: what was `"2026-08"` is
  now `{ kind: "literal", value: "2026-08" }`, and a computed default is
  `{ kind: "binding", ref: { kind: "compute", name: "currentMonth" } }`. Nothing in the
  YAML changed.

Also relaxed, which breaks nothing: a catalog component's props type **may** be generic.
The old rule said it must not be, and that rule was what made a union-typed action input
unbindable. For a *field* the relaxation now comes with the narrower rule above — generic
in the value it carries, one type parameter — because the unrestricted version let a
field lose its check silently.

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

**A computed filter default is not a server-decided value.** `compute#currentMonth` runs
during render in both processes rather than being resolved once on the server and handed
to the client, because nova emits no server-to-client data channel and the generated page
has nowhere to receive one. It is right for a clock-derived default and wrong for
anything a request would have to be asked for — a per-user preference, a tenant setting.
Those belong in a loader.

**Loading and error states are page-level, not per binding.** One slow
loader blanks the whole page, and one failing loader replaces it with the
error component. Per-binding states are not expressible.

**A generic *section* component's type parameter is left to inference.** Nova writes a
type argument for a field, because it knows the one type a field is about; a section has
no such type, so a generic section component resolves its parameter from the props the
spec binds. Where the parameter is reachable from one — `rows: data#trips` fixing a
table's row type — that is exactly right, and the derived props (`columns: (keyof Row &
string)[]`) are checked. Where it appears only inside a mapped or conditional prop type —
`toggles: Array<{ key: BooleanKeys<T> }>` — nothing infers it, it resolves to its
constraint, and `BooleanKeys<T>` then accepts any string at all with no diagnostic to say
so. Bind such a component behind a non-generic local component, which fixes the type
argument in your own code.

**An action bound to a callback that takes more arguments than the action's input is not
rejected.** `run` takes one parameter, and a one-parameter function is assignable to a
callback type with two, so `onPick: (id: string, index: number) => void` accepts an
action whose input is a `string`. The first argument is checked; the rest are ignored,
exactly as in ordinary JavaScript.

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
