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

The app directory may be relative (resolved against the process working directory) or
absolute; both answer identically, and every path in the result — `written`, and each
diagnostic's `file` — comes back absolute either way. Until 0.2.0 a relative one turned
the whole typecheck off silently, which is what this example used to demonstrate.

Nova never reads config from disk — you pass the value, so you can keep it in
whatever form your build already uses. `components`, `states`, `outDir` and
`tsconfigPath` are all required.

`importExtension` is `"" | ".js"`, optional, and defaults to `""` — bundler-style
resolution, with no extension appended to relative imports. A host on
`moduleResolution: "node16"` or `"NodeNext"`, or one running the emitted handlers as
plain Node ESM, must pass `".js"`; nothing else is accepted.

`outDir` is resolved against the app folder. `"generated"` is the ordinary answer and
`"src/gen/nova"` is fine; so is a path that escapes the app folder
(`"../../web/generated/trips"`) and so is an absolute one. The import specifiers back to
`data.ts`, `actions.ts` and `compute.ts` are computed from the two resolved directories,
so all four cases emit imports that resolve. Whatever you choose, the emitted files have
to be inside something your own `tsc` compiles.

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

A page has exactly one return path — the loading and error states are rendered per
section, not around the page (see [failing well](#failing-well)) — so a page's own chrome
never vanishes. Without a shell a page's sections emit into a bare `<></>`, which is what
they did before shells existed, so leaving `shell` unset changes nothing. The cost of leaving it
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

## Mounting the output

Two maps, and no framework behind either of them. Nothing below mentions Next: the
reference consumer is a Next App Router app, but a Vite/React SPA on `node:http` and an
Express app bundled with esbuild mount the same two maps with about twenty-five lines
each.

**`pages.tsx` exports the route map.**

```ts
export const pages: Record<string, React.ComponentType<{ params: Record<string, string> }>>;
```

Keyed by the route exactly as the spec wrote it, `:name` marking a parameter
(`"/trip/:id"`). **Nova ships no matcher** — matching a request path against those
patterns, extracting the parameters and passing them as `params` is the host's job, and
it is a short loop over `route.split("/")`. A component is an ordinary function
component; render it however your host renders one.

**`handlers.ts` exports the HTTP map.**

```ts
export const handlers: Record<
  string,
  (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>
>;
```

The keys are `"GET /_data/<loader>"` and `"POST /_actions/<action>"` — one per loader and
per action, method and path in one string, matched against the remainder of the path
*after* your mount (see `basePath` above). `Request` and `Response` are the Fetch API's,
not Node's: a `node:http` or Express host converts in both directions, and a Node host
whose tsconfig has no `lib: ["dom"]` needs `undici-types` (or `@types/node`'s globals) for
the names.

A loader's input arrives as the URL's search params; an action's is the parsed JSON body.
Both cross into your typed function through `as never` — see
[limitations](#limitations).

**`"use client"` is unconditional**, on `views.tsx` and `runtime.tsx`, and there is no
option to suppress it. In a host with no RSC boundary it is inert: Vite's esbuild
transform and standalone esbuild both drop module-level directives silently, with no
warning. The `pages.tsx`/`views.tsx` split costs such a host one extra five-line module
and nothing else.

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
type, and resolves the action's own result.** It reaches the component as
`deleteTripAction.run`, and the page hoists that as
`useAction<DeleteTripInput, Awaited<ReturnType<DeleteTrip>>>(…)`, so `run` is
`(input: DeleteTripInput) => Promise<DeleteTripResult | null>`:

```yaml
- ActivityList: { rows: data#trips, onDelete: actions#deleteTrip }
```

```tsx
// onDelete's parameter is what decides whether the action may be bound at all: `Trip`
// must be assignable to DeleteTripInput. Its return type is what the component may read.
export function ActivityList(props: {
  rows: readonly Trip[];
  onDelete: (row: Trip) => Promise<{ ok: boolean; warning?: string } | null>;
}): React.ReactElement { … }
```

A component shared by several actions declares the payload it carries and is generic in
it — `payload: T; onDelete: (input: T) => Promise<R>` — so the action and the data the
component was given have to agree. A mismatch is `NOVA3001` at the section's own line.
Before, `run` was `(input: unknown) => Promise<boolean>`, and an `unknown` parameter is
assignable to *every* callback shape there is, so nothing about the payload of an action
outside a form was ever checked.

**`null` is the action having given no answer** — the `confirm:` was declined, or the
request failed — and the message for that case is in `error` on the same hook. Everything
else is the action's own return value, parsed from the response body, so an action
declaring three outcomes hands the component three outcomes:

```ts
// actions.ts — the upstream accepted the claim but had something to say about it.
export async function submitMonth(input: { month: string }): Promise<
  { ok: true; warning?: string } | { ok: false; fieldErrors: Record<string, string> }
> { … }
```

A boolean `run` could not carry that middle case, and two converted production apps
answered it by showing a **failure for a submission that had persisted**, with the list
un-refreshed behind it. Note that the value crosses HTTP: it is the JSON of what your
action returned, so a `Date` in the result arrives as a string, and a result carrying no
`ok` key at all is treated as not-ok (no `refreshes:` runs, and `fieldErrors` is read from
it if present).

`filters.month.set` is a filter reference in write mode. It emits
`(value: string) => filters.set("month", value)`, which updates the query string and the
page together:

```yaml
- FilterBar: { label: Month, value: filters.month, onChange: filters.month.set }
```

Both `filters.set` and the sort setter below write the query string with
`history.replaceState`, keeping `pathname` and the fragment and replacing only the
search. **Back does not undo a filter or a sort** — `history.length` never moves — which
is deliberate for a control the reader is sweeping through, and worth knowing if you are
integrating with a router of your own. The fragment is preserved, so a hash-routed SPA
keeps its route; `popstate` is listened for, so a Back that arrives from elsewhere is
picked up.

`sortable:` marks which of a section's columns the reader may sort by. Nova owns the sort
state and its round trip through the URL — `?sort=` and `?dir=`, beside the filters — and
hands the component `sort` and `onSort`; ordering the rows is the component's own job.

```yaml
- Table: { rows: data#trips, columns: [date, km], sortable: [date, km] }
```

A page holds one sort state, so a second sortable section is `NOVA1011`. A sortable
column that is not a key of the row type the section's loader returns is a `NOVA3001` at
the `sortable:` line — checked against the type, so a catalog is free to call its column
prop `cols`, `headers` or anything else. `NOVA1009` is the same question answered from
the spec's own text alone, before any type is read, and applies where the section names a
literal `columns:` list.

**A literal `columns:` or `numeric:` list is checked the same way.** They are ordinary
props — nova forwards them and your component decides what they mean — but they are the
two names a column list is written under, and a name in one of them that is not a key of
the row type is the same `NOVA3001`, at that key's own line. Until 0.2.0 neither was
checked at all: `columns: [dayz]` compiled clean and rendered a column of en dashes under
a `DAYZ` header, and a misspelled `numeric:` silently did nothing. A catalog spelling its
column list something else gets no check, exactly as before.

The row type is taken from the one value the section reads from a loader, **including the
path into it**: `rows: data#travel.days` is checked against the element type of
`Travel["days"]`, not of `Travel`. A section reading two different loader values is not
checked — there is no single row type the columns belong to, and nova will not pick — and
neither is one whose data is not a list of objects.

### Sorting what the browser does not hold

Ordering the rows is the component's job **as long as the component has all the rows**.
For a table showing page 2 of 88, sorting the 25 rows on screen is a wrong answer about
6,480, so sort state has to reach the loader — and it does, on exactly the terms a filter
value does:

```ts
// data.ts — the signature is the opt-in.
export async function deals(input: {
  region: string;                  // a route param or a filter, as ever
  page: string;
  sort: string;                    // the column, "" when nothing is sorted
  dir: "asc" | "desc";             // "asc" when nothing is sorted
}): Promise<Deal[]> { … }
```

A loader whose input names `sort` and/or `dir` is given the page's sort state and is
re-requested when it changes. A loader that names neither is not, and sorts in the
browser exactly as before — which is right for a table that holds all its rows.

The declaration lives in the loader's signature rather than in the YAML because that is
where the fact belongs: the function that has to honour the ordering is the one that
says it can, and the keys are then checked against the loader's input like every other
one. A page with a sortable section supplies them; a loader that asks for `sort` on a
page that has none is the same "missing property" `NOVA3001` as a loader asking for a
filter the page does not declare.

Because those two names are nova's, a page that declares a filter called `sort` or `dir`
*and* has a sortable section is `NOVA1014` — two owners for one query parameter, which
used to compile and then fight itself in the browser. Without a sortable section on the
page the names are yours.

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
| `states.loading` | `<Loading />`, once per waiting section | every prop optional — it is given none at all |
| `states.error` | `<ErrorNotice>{message}</ErrorNotice>`, in place of the failed section | `children` — the message is not a prop |
| a form shell (`submit:`) | `busy`, `error`, `onSubmit`, its fields as children | `busy: boolean`, `error: string \| null`, `onSubmit: () => Promise<boolean>`, `children` |
| a field (`fields:`) | `value`, `onChange`, `error`, **and `name`** | `name: string`, `value`/`onChange` at that input key's own type, `error?: string` |
| a sortable section (`sortable:`) | `sort`, `onSort`, and `sortable` itself | `sort: { column: string; direction: "asc" \| "desc" } \| null`, `onSort: (column: string) => void`, `sortable: string[]` |

A field's `name` is both the wiring and an ordinary prop: nova uses it as the key of the
action's input **and** forwards it, because a field almost always wants it for its
label's `htmlFor`. That is deliberate, so declare `name: string` on every field
component.

### Keys nova reads

Under a section, these keys are spec vocabulary rather than props. The list is
exhaustive; everything else you write is forwarded.

| Key | Forwarded? | What it means |
| --- | --- | --- |
| `submit:` | no | the action this section's form submits — this is what makes it a form |
| `fields:` | no, **when `submit:` is present** | the form's inputs |
| `confirm:` | no | the message shown before the one action this section runs |
| `refreshes:` | no | the loaders a successful action invalidates |
| `children:` | no | nested sections |
| `initial:` (on a field) | no | that field's starting value |
| `sortable:` | **yes** | the sortable columns — wiring *and* a prop the component reads |

`fields:` is the one with a foot in both camps, and it is conditional for that reason: it
is an ordinary prop name for a read-only component (a roster, a column list), so on a
section with no `submit:` it is forwarded like anything else and the component's own type
decides. A form that genuinely forgot its `submit:` is then a `NOVA3001` at that section —
a field list meeting a prop that is not one — rather than a spec error nova asserts from
the key's name.

`submit:`, `confirm:`, `refreshes:` and `children:` have no such escape. A component
wanting a prop by one of those names has to be wrapped, or the prop renamed.

`states.empty` is optional and no generated page renders it. A section knows whether its
own rows are empty and nova does not, so the empty state belongs to your table — as an
ordinary `empty:` prop of it. Where `states.empty` is given it is still resolved against
the catalog, so a name that does not exist is still a build error; that is the whole of
what it does.

## Failing well

**A page degrades one section at a time.** Each section that binds a loader renders behind
its own conditional — the error state where that section's data failed, the loading state
where it has not arrived, the section itself otherwise — and a section that binds no
loader is not gated at all:

```tsx
<PageShell title={"Trips"}>
  <TabNav … />                                             {/* chrome: always rendered */}
  {stats.error !== null ? <ErrorNotice>{stats.error}</ErrorNotice>
    : stats.value === null ? <Loading /> : <StatGrid stats={stats.value} />}
  {trips.error !== null ? <ErrorNotice>{trips.error}</ErrorNotice>
    : trips.value === null ? <Loading /> : <Table rows={trips.value} … />}
</PageShell>
```

So one failing loader costs one section, not the page, and a page's first paint is its
chrome with a spinner where the data goes rather than a bare `Loading`. This replaced a
page-level gate — `if (error) return <ErrorNotice>` above every section — under which one
loader out of five failing replaced the navigation, the header, the stats, every section
and both forms with a single line.

**One loader's failure is stated once.** The section is the unit that degrades; it is not
the unit a failure is *reported* in. The first section that binds a loader renders the
notice, and a later section whose data failed for the same reason renders nothing — it
has no data, and the reason is already on the screen above it:

```tsx
{travel.error !== null ? <ErrorNotice>{travel.error}</ErrorNotice>
  : travel.value === null ? <Loading /> : <StatGrid stats={travel.value} />}
{travel.error !== null ? null                                 {/* said once, above */}
  : travel.value === null ? <Loading /> : <DayTable rows={travel.value.days} />}
```

A detail page hangs five sections off one loader, so a stale link used to print the same
sentence four times over; a report page printed six. The **loading** state is deliberately
not deduplicated: a spinner marks where a section will be, and four of them in four places
is what a page still arriving looks like, whereas four copies of one sentence is one fact
asserted four times.

**A section that holds controls should not bind data it does not need.** If the card
carrying your date pickers also binds the report those pickers scope, a bad date range
takes the card with it and the reader has no way left to correct the range. Where the
controls do not actually need that data, the fix is one line of YAML: put them in their
own section, which binds no loader and is therefore never gated at all (see the `TabNav`
above). That is the case worth checking first, and it is the one a report page usually
has.

Where the controls genuinely need the data — an entity **picker** whose entity list
403s — splitting does not help, and nova cannot yet express what the hand-written
originals do, which is to show the picker with the failure inline. A section is
all-or-nothing on its loader's error, so an app that wants the page has to put the failure
in the payload (`{ entities: [], error }` at 200) and give up the status on the wire. See
[limitations](#limitations).

`.value` is still narrowed: the conditional is written one loader at a time so that
`trips.value` is non-null in the branch that reads it. Nothing is asserted or cast, so a
prop bound to the wrong type is still a `NOVA3001` at the spec line that bound it.

**A loader or action decides what its failure is worth.** A generated handler answers with
the status a thrown value asks for:

```ts
// data.ts — a stale link is a stale link, not a server fault
if (rows.length === 0) {
  throw Object.assign(new Error("This trip no longer exists."), { status: 404 });
}
```

A numeric `status` between 400 and 599 is answered as
`{ ok: false, error: <message> }` with that status. **Anything else is re-thrown
unchanged**, so an unexpected fault still reaches your host's own error handling — its
logging, and whatever it maps a storage outage to — rather than a 500 nova invented. The
page shows the message the loader wrote, falling back to `404 Not Found` when the body
carries none.

A loader that has nothing to return cannot express it by resolving to `null` — that is
the loading state — so this throw is how "not found" is said.

**A malformed request body is a 400.** `await req.json()` rejects on a body that is not
JSON; that is the caller's mistake, and the generated action handler answers
`400 {"ok":false,"error":"invalid JSON body"}` rather than letting it surface as a server
error. So is a body that parses but is not an object — `null`, `12`, `"trip"`, `true`.
`JSON.parse("null")` succeeds, and `null` then met an action expecting an object and threw
on its first property access, which a host answers as a 500. An action's declared input is
an object type; that is exactly what the `as never` at the handler boundary asserts, and
this is the one part of it that is checked.

## Loader inputs

A loader's input object is assembled from the page's route params, its filter values and
(where the loader asks for them) its sort state, and is checked against the loader's own
declared parameter type. If a loader declares `{ month: string; region: string }` and the
page supplies neither, that is a `NOVA3001` at the spec line that named the loader — not a
generated call that fails at runtime. Where a route param and a filter share a name, the
route param wins.

**A loader is given the keys it declares, and no others.** A loader declaring
`{ region: string }` on a page with three filters is called with `{ region }` alone, and
is therefore re-requested when `region` changes and not when the other two do; a loader
declaring no parameters at all is called with `{}` and is never re-requested by a filter.
That matters as soon as a page has more than a loader or two: a reporting page with three
filters and seven loaders used to issue seven requests per filter click, three of them for
option lists that cannot change.

The narrowing needs a closed set of keys to read. Where the parameter type has none — an
index signature (`Record<string, string>`), a primitive, a bare type parameter — the whole
set is passed, as it always was.

Filter values are **always strings**, because they live in the query string. A loader
that wants a number parses it (`Math.max(1, Number(input.page) || 1)`), and a filter's
`default:` is written as one (`page: { default: "1" }`). Nova does not coerce.

Generated code is safe under `noUncheckedIndexedAccess`. Filter values are keyed by
the filter names the page declares rather than by an open index signature, and each
route param a page reads is narrowed into a local once at the top of the page function.

### Reading a dataset too big to send

Nothing here is new vocabulary; it is the three pieces above in the arrangement a report
wants, written down because every consumer has had to invent it.

**Pagination** is a filter and a second loader: `page: { default: "1" }` feeds the rows
loader, and a `pageCount` loader declaring the same scope feeds the pager. Both are
ordinary loaders; the filter setter (`filters.page.set`) is what the pager calls.

**Sorting** such a table means declaring `sort` and `dir` in the rows loader's input —
see [sorting what the browser does not hold](#sorting-what-the-browser-does-not-hold).

**Export** — CSV, PDF, anything that is not JSON — is a route you write. Generated
handlers answer `Response.json` only, and a spec that could describe a file format would
be a reporting engine rather than a UI compiler. The spec's contribution is handing the
filter values to a component that builds the URL:

```yaml
- CsvLink: { endpoint: /reports/export.csv, scope: filters.region, span: filters.quarter }
```

which means the export sees exactly the filters that component was handed, and nothing
about the sort unless you pass that too.

## Diagnostics

Codes are stable.

- `NOVA1xxx` — a problem in the spec file itself (YAML syntax, schema shape,
  unknown or missing keys). `NOVA1007` is a `confirm:` or `refreshes:` with other
  than exactly one action to attach to; `NOVA1008` two fields editing the same key;
  `NOVA1009` a sortable column the section's own literal `columns:` list does not
  have — the spec-text half of that check, which needs no type information and so
  belongs in this block; the type-derived half, against the row type the section's
  loader returns, is a `NOVA3001`;
  `NOVA1010` one page binding the same action in two ways nova cannot reconcile
  (two different `confirm:` messages or `refreshes:` lists, or two forms on one
  action); `NOVA1011` more than one sortable section on a page; `NOVA1012` a
  `refreshes:` naming a loader that page's own sections do not bind — the next
  free number in the block, and a spec-file problem like the rest of it, since it
  is answered from the page's own text with no catalog or type information;
  `NOVA1013` a filter `default:` bound to a namespace other than `compute#` — the
  next free number after it, and in this block for the same reason: whether
  `data#trips` may be a default is answered by the spec's own text, before any
  catalog is read; `NOVA1014` a page declaring a filter named `sort` or `dir`
  while also having a sortable section — the next free number in the block, and
  in it because the collision is between two names the spec itself writes, `?sort=`
  and `?dir=` being nova's own two query parameters.
- `NOVA2xxx` — name resolution: an unknown component, a missing catalog
  module, a `data.ts`/`actions.ts`/`compute.ts` export that doesn't exist, a
  filter/route parameter reference that doesn't match its page, or one name
  bound to two different things — `NOVA2009` where the spec binds one name two
  ways (a component name bound to two modules, or a loader and an action sharing
  a name), and `NOVA2010` where two *catalog modules* both export a component of
  the same name, which is a fact about `components:` rather than about the spec.
  `NOVA2012` is a field component asking for more
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

### Since 0.1.0 — four defects three converted production apps found

An equivalence audit converted three production apps and compared each against the
original it replaces. One of these four was the single blocker keeping a conversion from
replacing its original; two more can turn a build that passed into one that reports.

- **`run` resolves the action's own result, not `boolean`.** `useAction` is
  `useAction<Input, Result>` and its `run` is `(input: Input) => Promise<Result | null>`.
  **What a host must do:** every component prop an `actions#` binding is bound to has to
  declare a callback returning what the action returns (or `Promise<R>`, generic, or
  `void` if it ignores the answer). A prop declared `(input: X) => Promise<boolean>` now
  fails. This is the fix for a submission the upstream **accepted with a warning** being
  shown to the user as an outright failure, with the row already written and the list not
  refreshed — which two of the three conversions did:

  ```diff
  -export function ActionButton<T>(props: {
  -  payload: T;
  -  onSubmit: (input: T) => Promise<boolean>;
  -}) { … }
  +export function ActionButton<T, R>(props: {
  +  payload: T;
  +  onSubmit: (input: T) => Promise<R>;
  +}) { … }
  ```

  `useForm` is unchanged where a host meets it: `submit()` is still `() => Promise<boolean>`
  and a form shell still declares `onSubmit: () => Promise<boolean>`. It reads its verdict
  off the action's own `ok` now; the per-field errors were always cleared by `useAction`'s
  own state, and still are.
- **A literal `columns:` or `numeric:` list is checked against the row type** — see
  [sorting](#confirmation-filter-writes-and-sorting). **What a host must do:** expect a
  `NOVA3001` at that line where a name is not a key of the row type. All three mileage
  conversions had at least one such list and none of them was checked before. The row type
  now follows the binding's path (`data#travel.days`), which also makes an existing
  `sortable:` check on such a section real rather than vacuous.
- **One failed loader renders one error notice**, not one per section that binds it — see
  [failing well](#failing-well). Behaviour only; no spec or catalog change. A host that
  counted the notices on a failed page will count fewer.
- **A JSON body that parses to a non-object is a 400.** `null`, `12`, `"trip"` and `true`
  answered 500; both original apps answer 400. Behaviour only.
- **`useAction` shows the refusal the action wrote.** It discarded the body of a non-2xx
  answer and reported `403 Forbidden` where the action had written *"You do not have
  access to invoice reporting."* — the same defect `useLoader` had, fixed the same way.
  Behaviour only; this is what makes a status-carrying throw usable from an action.

Recommended version for these: **0.2.0**, alongside the three sets below.

### Since 0.1.0 — what two foreign consumers found

Eight fixes from building a Vite/React SPA and an Express reporting app against this
README alone. Three of them can turn a build that passed into one that reports, and the
first can do so dramatically.

- **A relative `appDir` no longer disables the typecheck.** `typecheckEmitted` keyed its
  file map on a path built from `appDir`, and TypeScript reports every file name
  absolute, so with a relative `appDir` the map matched nothing and *every*
  `NOVA3001`/`NOVA3002` was discarded — `ok: true` on output that does not compile. This
  README's own example passed a relative path. **What a host must do:** expect real
  diagnostics on the first build after upgrading if your build script passed one. They
  were always there.
- **A sortable column is checked against the row type.** Previously only against a
  literal `columns:` prop, so a catalog spelling it anything else got no check at all.
  **What a host must do:** a `sortable:` entry has to be a key of the row type the
  section's loader returns, or it is a `NOVA3001` at that line. Sections binding two
  loaders, and loaders that do not return a list of objects, are unchecked as before.
- **A filter named `sort` or `dir` beside a sortable section is `NOVA1014`.** Both wrote
  the same query parameter; it compiled and then fought itself.
- **A loader is called with the keys its own input declares.** A parameterless loader now
  gets `{}` instead of the page's whole filter set. The request URLs change and there are
  far fewer of them; nothing about a loader's signature changes.
- **Sort state reaches a loader that declares `sort`/`dir`** — see
  [sorting what the browser does not hold](#sorting-what-the-browser-does-not-hold). A
  loader that declares neither is untouched.
- **`fields:` on a section with no `submit:` is an ordinary prop**, not `NOVA1002`. This
  only removes an error.
- **Filter and sort writes keep `location.hash`.** A hash-routed SPA lost its route on
  every filter change.
- **`outDir` may escape the app folder or be absolute.** The specifier back to `data.ts`
  was computed relative to `process.cwd()`; it is computed from the two resolved
  directories now, so those two cases emit imports that resolve instead of ones that do
  not.

The emitted `views.tsx` also hoists `const sortState = useSort()` above the loaders
rather than below them, since a loader may now read it. Output stays byte-deterministic;
it is simply not byte-identical to 0.1.0's.

### Since 0.1.0 — a page that fails one part at a time

Behaviour, not types: nothing here can turn a build that passed into one that reports, and
no spec or catalog changes. See [failing well](#failing-well).

- **Loading and error states moved from the page to the section.** A page no longer
  returns early; each data-bound section renders its own state in place. A host that
  counted on exactly one `states.loading` on screen, or on a failed page being blank, will
  see the chrome and the sections that did load instead. `states.loading` may now be
  rendered more than once on one page, so it must stay cheap to render.
- **A loader or action failure carries its own status.** A thrown value with a numeric
  `status` (400–599) becomes that status and `{ ok: false, error }` rather than an
  exception; **anything without one is re-thrown unchanged**, so a host's error handling
  is untouched. **What a host may want to do:** a loader that throws for "not found" —
  the only way to say it, since `null` is the loading state — should attach
  `{ status: 404 }`, or it stays whatever the host makes of an unhandled throw.
- **A malformed request body is a 400.** `POST /_actions/<name>` answers
  `{"ok":false,"error":"invalid JSON body"}` with status 400 instead of throwing out of
  the handler. A host wrapper that caught that throw will no longer see it.

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

**A refetch shows the previous answer, with nothing saying so.** `useLoader` keeps its
last value while re-requesting, and no generated page reads the `loading` flag, so
changing a filter leaves each affected section showing the old numbers until the new ones
land. That is the right trade for one table — it avoids a flash of spinner on every
keystroke — and a thinner one for a page of six, where several sections are briefly
wrong together. A component that wants to say so has to be told by something the spec
does not yet express.

**Loading is inferred from `value === null`, not from `state.loading`.** A
section shows the loading component while any loader it binds has a null value.
A loader that legitimately resolves to `null` — `Promise<Trip | null>`, an
ordinary signature — therefore pins that section on the loading state; throw a
`status`-carrying error instead (see [failing well](#failing-well)). The
`loading` flag `useLoader` maintains is not read by any generated page.

**A computed filter default is not a server-decided value.** `compute#currentMonth` runs
during render in both processes rather than being resolved once on the server and handed
to the client, because nova emits no server-to-client data channel and the generated page
has nowhere to receive one. It is right for a clock-derived default and wrong for
anything a request would have to be asked for — a per-user preference, a tenant setting.
Those belong in a loader.

**A section is the unit that degrades, not a binding.** A section renders its
error state where any loader it binds failed and its loading state where any of
them has not answered, so two loaders on one section share a fate even when only
one of them is missing. Nothing renders half a section, and a section cannot say
"show the table without the total".

**A loader cannot carry both a payload and a status, so a section cannot show its
own failure inline.** A generated handler answers either a value at 200 or
`{ ok: false, error }` at the thrown status, and `useLoader` discards the body of
any non-2xx response and nulls its `value` — so `LoaderState`'s `error` and
`value` are never both meaningful, and the section is replaced wholesale. A
section holding controls the reader needs *in order to recover* — an entity
picker whose list 403s, beside the date pickers and the Run button — therefore
has to choose between the right status on the wire and a usable page. The
workaround, and it is a workaround, is to return the failure inside the payload
(`{ entities: [], error }` at 200) so the section renders and prints its own
message. Doing this properly needs three things nova does not have: a loader
result that carries a status *beside* a value, a `useLoader` that keeps `value`
when one is present, and a per-section way for the spec to say the error is a
prop rather than a replacement. That is a spec-surface change and is deliberately
not in 0.2.0.

**An action refuses with a status, but not with per-field detail.** An action that
throws `Object.assign(new Error("You may not."), { status: 403 })` is answered
with that status, and `useAction` now surfaces that sentence in `error` — which a
form shell renders — rather than the bare `403 Forbidden` it used to show. What
it cannot do is refuse *and* return the `{ ok: false, fieldErrors }` envelope: a
throw leaves the form-level `error`, and a returned rejection is always HTTP 200.
An action wanting a status on a per-field rejection has to pick one. Authorization
is not validation, and the format cannot yet say so in one answer.

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
