# @desmondzee/nova

A build-time compiler that turns a declarative YAML description of an app's UI into
React pages and HTTP handlers, typechecked by your own TypeScript.

## Does this fit your problem?

Nova compresses **repetition across a family of near-identical apps** — the same screen
with a different lookup table and a different set of rules. It does not compress UI in
general. The agent of compression is a shared component catalog; the compiler's
contribution is consistency — filters in the URL, race guards, per-section degradation,
one dispatch layer — rather than volume.

Five production apps were converted and each compared against the original it replaced,
across four groups of differing shape:

| Group | Apps sharing the shape | Line delta |
| --- | ---: | ---: |
| Entry forms, one screen per rule set | a dozen or more | **−23%** first, **−32%** second |
| Read-heavy reports over an external API | under ten | +10% |
| Vendor integrations that post to a ledger | under ten | +19% |
| One-off complex screens | under ten | +6%, and 89% of it behind escape hatches |

Only the largest group — a dozen-plus apps over one shared catalog — shrank. Below
roughly three apps sharing a shape the arithmetic inverts, because a single app pays on
its own for its spec, its `data.ts`/`actions.ts` split, its committed `generated/`
output, and every catalog component it has to write and cannot share.

- **Worth it** for three or more internal tools, admin panels, reporting screens or
  entry forms that are the same shape with different rules.
- **Not worth it** for one complex screen. It will cost more than it saves.

## What it is, and is not

Nova ships **no components**, and **generated code imports nothing from nova** — only
your catalogs, your app's own files, and React. Components come from your codebase, and
every type check is performed by your TypeScript rather than reimplemented.

It compiles the UI layer only. It does not model an API, describe queries, own
pagination or retries, or render documents.

It is not runtime-free in the sense that phrase usually carries. There *is* a runtime —
fetching, race-guarding, query-string round-tripping, confirmation and form state — and
nova **vendors a copy of it into every app** as `generated/runtime.tsx`. Only the hooks
an app actually uses are emitted: 50 lines for a loaders-only app, 190 for one using
loaders, filters and a form, around 230 with sorting as well, and 4 for a spec that binds
nothing. Nothing links back to nova, so nothing of nova's is in your `package.json` or
your bundle; the cost is that a fix to that runtime is one regenerated file per app
rather than one version bump. See [limitations](#limitations).

The vocabulary, once, because everything below uses it: a **spec** (`app.yaml`) declares
**pages**; a page holds **sections**, and a section names a component, gives it props, and
may nest more sections under `children:`. Data comes from **loaders** in `data.ts` and
mutations from **actions** in `actions.ts`, both ordinary typed functions you write. Every
component a spec names comes from a **catalog** — a module listed in the `components`
config. [What an app looks like](#what-an-app-looks-like) shows all of it at once.

## Install

```bash
pnpm add -D @desmondzee/nova 'typescript@>=5.5 <7'
```

The version bound is not decoration: TypeScript 7's main entry does not export the
compiler API at all, so it is outside nova's peer range and nova refuses it by name. See
[Requirements](#requirements).

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

const { spec, diagnostics } = parseSpec("apps/orders/app.yaml", source);
```

`./schema`'s `validate(raw, positions)` is the same check without the YAML dependency —
for a consumer that already holds a parsed document. `positions` maps a path inside the
document to a source position; `loadSpecFile` (exported from `./compile`) builds a
precise one from the YAML, and `atFile(file)` (exported from `./schema`) is the
dependency-free fallback that pins every diagnostic to the top of the named file.

## Use

```ts
import { compileApp } from "@desmondzee/nova/compile";

const result = await compileApp("apps/orders", {
  components: ["@acme/ui"],
  states: { loading: "Loading", error: "ErrorNotice" },
  shell: "PageShell",
  outDir: "generated",
  tsconfigPath: "tsconfig.json",
  basePath: "/api/apps/orders",
});

for (const d of result.diagnostics) {
  console.error(`${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`);
  // Print these too. `hint` is where "did you mean 'Table'?" lives; `related` is the
  // other positions a diagnostic points at — the generated line behind a NOVA3001, or
  // the two declarations behind a name collision.
  if (d.hint !== undefined) console.error(`  ${d.hint}`);
  for (const r of d.related ?? []) console.error(`  ${r.file}:${r.line}:${r.col} ${r.message}`);
}
process.exit(result.ok ? 0 : 1);
```

`compileApp` returns `{ ok, diagnostics, files, written }` and never throws for a
problem in your spec or config. A `Diagnostic` is
`{ code, severity, message, file, line, col, hint?, related? }` — `severity` is
`"error" | "warning"`, and `related` entries are `{ file, line, col, message }`. Codes
are stable; message wording is not, so assert on `code`.

The app directory may be relative (resolved against the process working directory) or
absolute; both answer identically, and every path in the result — `written`, and each
diagnostic's `file` — comes back absolute either way.

### Config

Nova never reads config from disk — you pass the value, so you can keep it in whatever
form your build already uses. `components`, `states`, `outDir` and `tsconfigPath` are
required; the rest are optional.

Every field is checked at runtime before it is used. `NovaConfig` is a type, and a type
checks nothing for a build script written in JavaScript or a config read from JSON, so a
missing or wrong-typed field is `NOVA2014` naming the field, with every problem in one
run rather than a `TypeError` out of whichever stage first touched it.

**`components`** — the catalogs: module specifiers whose capitalised, callable exports a
spec may name.

**`states`** — `{ loading, error }` are required and `empty` is optional; see
[what nova renders itself](#what-nova-renders-itself).

**`outDir`** is resolved against the app folder. `"generated"` is the ordinary answer;
so are `"src/gen/nova"`, a path that escapes the app folder
(`"../../web/generated/orders"`), and an absolute one. The import specifiers back to
`data.ts`, `actions.ts` and `compute.ts` are computed from the two resolved directories,
so all four cases emit imports that resolve. Whatever you choose, the emitted files have
to be inside something your own `tsc` compiles.

**`tsconfigPath`** — the tsconfig used to resolve modules and typecheck emitted output.

**`shell`** is optional and names the component every page is wrapped in — **the one
place spacing and structure between top-level sections belongs**. Nova hands it the
page's `title:` and the sections as `children`:

```tsx
<PageShell title={"Orders"}>
  <FilterBar … />
  <Table … />
</PageShell>
```

A page has exactly one return path — loading and error states are rendered per section,
not around the page (see [failing well](#failing-well)) — so a page's own chrome never
vanishes. Without a shell a page's sections emit into a bare `<></>`; the cost is that
vertical rhythm has nowhere to live but inside each component.

**`importExtension`** is `"" | ".js"` and defaults to `""` — bundler-style resolution,
with no extension appended to relative imports. A host on `moduleResolution: "node16"`
or `"NodeNext"`, or one running the emitted handlers as plain Node ESM, must pass
`".js"`; nothing else is accepted.

**`basePath`** defaults to `""`. It is the path your host mounts this app's handler map
at, and it prefixes the URLs the generated client fetches: `"/api/apps/orders"` turns
`fetch("/_data/orders")` into `fetch("/api/apps/orders/_data/orders")`. The **keys of
`handlers`** deliberately do not move with it — they are matched against the remainder
of the path *after* your mount, so prefixing both halves would double the prefix.

**`columnProps`** defaults to `["columns", "numeric"]`. It names the props whose literal
string-array value nova checks against the row type the section's loader returns — see
[sorting](#actions-and-sorting). The default is a common naming convention, not a rule: a
catalog spelling its column list `cols` puts that here and gets the same check, and a
catalog whose `columns` prop carries display *labels* rather than row keys sets
`columnProps: []` and gets none. `sortable:` is nova's own word and is checked whatever
this says.

### Nova will not write over a file it did not write

The six output names are ordinary names in a hand-written app folder, and `outDir: "."`
puts them beside `data.ts`, so before writing anything nova checks each destination for
its own header line. A file that does not carry it — or a directory sitting at one of
the names — is `NOVA2016` at that file, and **nothing is written at all**: the refusal is
all-or-nothing rather than five files replaced and one skipped. `result.files` still
holds what nova would have written, so a build script can diff. Re-writing nova's own
previous output is the ordinary case and carries the header.

### Compiling more than one app

Every app's compile builds a few `ts.Program`s, and most of what they parse — the lib
files, `@types/*`, your component catalog — is the same for all of them. Pass one
session to every call and that work happens once:

```ts
import { compileApp, createSession } from "@desmondzee/nova/compile";

const session = createSession();
for (const app of apps) {
  const result = await compileApp(app, config, { session });
  // report result.diagnostics as above
}
```

Results are identical either way; a session only removes repeated work. On a repo of a few
dozen apps with a repository-wide tsconfig `include`, sharing one took the build from 65s
to 3.3s and peak memory from 2.3GB to 0.7GB. Every cached entry is revalidated against the
file's modification time and size, so a session is safe to hold across rebuilds in a watch
loop. The one thing it will not notice is a *new* file appearing under the tsconfig's
`include` while the tsconfig itself is unchanged — call `createSession()` again if that
can happen.

## What an app looks like

```
apps/orders/
├── app.yaml       the spec
├── data.ts        typed async loaders
├── actions.ts     typed mutations
├── compute.ts     plain functions a spec may call (optional)
└── generated/     emitted: pages.tsx, views.tsx, handlers.ts, types.ts, runtime.tsx, __contract.ts
```

`app.yaml`, `data.ts`, `actions.ts` and `compute.ts` are exact, lowercase names, and the
lowercase part is checked rather than assumed. macOS and Windows fold filename case, so a
`Data.ts` resolves there and nova would emit `from "../data"` — a specifier that does not
exist on Linux, discovered by CI inside generated code you did not write. Nova compares
the name on disk against the name it expects and reports `NOVA2015` instead of emitting.

`pages.tsx` and `views.tsx` are one module split in two, and the split is load-bearing
under React Server Components. `views.tsx` carries `"use client"` and exports one
component per route (`Page_0`, `Page_1`, …); `pages.tsx` carries **no** directive and
imports them. A server module that imports a `"use client"` module receives *client
references* rather than values, so a route map exported from the client half reads back
as `{}` — the host matches no route and 404s with nothing to show for it. Mount `pages`
from `pages.tsx`; nothing needs to import `views.tsx` directly.

A minimal spec, and the loader behind it:

```yaml
# app.yaml
pages:
  "/":
    title: Orders
    filters:
      month: { default: "2026-08" }
    sections:
      - Table:
          rows: data#orders
          columns: [date, total]
          empty: No orders yet
```

```ts
// data.ts
export async function orders(input: { month: string }): Promise<Array<{ date: string; total: number }>> {
  // …
}
```

Components are resolved by name against the modules listed in `components`. A bare
capitalised name must be exported by one of them; a name that is not resolves to a build
error listing what is available. Anything a spec cannot express is referenced by path
instead — `./views/charts#BridgeChart` — and still gets its props typechecked.

## Mounting the output

Two maps, and no framework behind either of them. Nothing below mentions Next: a
Next App Router app, a Vite/React SPA on `node:http` and an Express app bundled with
esbuild each mount the same two maps with about twenty-five lines.

**`pages.tsx` exports the route map.**

```ts
export const pages: Record<string, React.ComponentType<{ params: Record<string, string> }>>;
```

Keyed by the route exactly as the spec wrote it, `:name` marking a parameter
(`"/order/:id"`). **Nova ships no matcher** — matching a request path against those
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
whose tsconfig has no `lib: ["DOM"]` needs `undici-types` (or `@types/node`'s globals) for
the names.

A loader's input arrives as the URL's search params; an action's is the parsed JSON body.
Both cross into your typed function through `as never` — see
[limitations](#limitations).

**`"use client"` is unconditional**, on `views.tsx` and `runtime.tsx`, and there is no
option to suppress it. In a host with no RSC boundary it is inert: Vite's esbuild
transform and standalone esbuild both drop module-level directives silently. The
`pages.tsx`/`views.tsx` split costs such a host one extra five-line module and nothing
else.

## Filters

A filter is a name and an optional `default`. The value is kept in the query string, so a
refresh preserves it, and it feeds the input object of every loader on the page that asks
for it. `default` is a literal, **or a `compute#` binding nova calls for the value**:

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
magic string: it reuses the machinery every other reference uses, keeps time handling in
your code, and is checked — a `currentMonth` returning a `number` is a type error at the
page's own `filters:` block, because a filter value is a `string`. Only `compute#` is
accepted; any other namespace is `NOVA1013`, since a `data#` value is asynchronous and
arrives after the filter has already fed its own loader, and `params.`/`filters.` are page
state that does not exist yet when a default is needed.

**A computed default is evaluated during render, on the server as well as in the
browser.** Keep it a pure function of the clock and nothing else; two processes in
different time zones, or a render that straddles midnight on the 1st, can disagree, and
the client's answer is the one that survives. The value is a seed either way: the effect
that adopts the query string overwrites it whenever the URL carries one.

`filters.month.set` is the same reference in write mode. It emits
`(value: string) => filters.set("month", value)`, which updates the query string and the
page together:

```yaml
- FilterBar: { label: Month, value: filters.month, onChange: filters.month.set }
```

Both `filters.set` and the sort setter write the query string with
`history.replaceState`, keeping `pathname` and the fragment and replacing only the search.
**Back does not undo a filter or a sort** — `history.length` never moves — which is
deliberate for a control the reader is sweeping through, and worth knowing if you are
integrating with a router of your own. The fragment is preserved, so a hash-routed SPA
keeps its route; `popstate` is listened for, so a Back that arrives from elsewhere is
picked up.

## Forms

A section that carries `submit:` is a form. Its `fields:` each name a key of the action's
input type, and that is checked by TypeScript rather than by nova:

```yaml
- Form:
    submit: actions#saveOrder
    confirm: Save this order?
    fields:
      - DateField:   { name: date,      label: Date }
      - NumberField: { name: total,     label: Total, initial: 0 }
      - TextField:   { name: reference, label: Reference }
```

```ts
// actions.ts
export interface OrderInput { date: string; total: number; reference: string }

export async function saveOrder(input: OrderInput):
  Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> { … }
```

The page holds the form in `useForm<SaveOrderInput>`, where `SaveOrderInput` is
`Parameters<typeof actions.saveOrder>[0]`. Each field emits `values["total"]`,
`set("total", value)` and `errors["total"]` against it, so three things are compile errors at
the spec line rather than runtime surprises:

- **a field naming a key the action does not accept**, reported on that field's own line;
- **a field whose value type does not match the key's** — a `NumberField` on a `string`
  key — because `onChange`'s parameter type comes from the component and `set`'s from the
  action;
- **a form that does not cover every required key of the input**, reported on the
  `- Form:` line, because the field list is what assembles `useForm`'s initial values.

`initial:` on a field is its starting value, defaulting to `""`. A `NumberField` that does
not say `initial: 0` gets a type error at the form, which is the right place to be told.

Nova supplies `onSubmit`, `busy` and `error` to the form component and `value`, `onChange`
and `error` to each field, so a catalog's field components must accept those — the exact
shapes are in [what nova renders itself](#what-nova-renders-itself). `name` and any other
prop you write are forwarded as usual. A spec that also sets one of the supplied props is
`NOVA1001` rather than a silent override. `fieldErrors` returned by the action land on the
matching field automatically.

### Binding a union-typed key

An action whose input narrows a key — `channel: "web" | "phone"` — needs a field component
that can carry that type. `onChange`'s parameter type comes from the component, so a
picker declaring `onChange(value: string): void` cannot be bound to it: `string` is not
assignable to the union, and rightly so, since such a picker may emit `"post"`. **Write
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

Nova emits an unannotated lambda — `(value) => form.set("channel", value)` — and
**writes the type argument itself**:

```tsx
<ChoiceField<SaveOrderInput["channel"]> value={…} onChange={(value) => …} … />
```

Leaving the type parameter to inference is not enough on its own: a parameter that none of
the props nova supplies mentions is inferred from nothing, resolves to its constraint, and
every type derived from it — `BooleanKeys<T>`, `Record<T, string>` — quietly stops
constraining anything. Writing the one type nova does know closes that.

The one rule to know when writing a field component: **a generic field component is
generic in the value it carries.** Its first type parameter is the type of the key it
edits; a component generic in something else — the whole record, a set of keys — will be
handed a type argument it cannot accept, which is a `NOVA3001` at that field's line. A
component needing more than one type argument is `NOVA2012`, because nova has one to give.
Give the extras defaults, or wrap the component. Declare a constraint (`T extends string`
above) rather than a bare `<T>`: it is what keeps the literal types from widening during
inference.

Nothing is cast, so nothing is silenced. What it catches:

| Spec | Diagnostic |
| --- | --- |
| an option outside the union (`{ value: post }`) | `NOVA3001` at the field's line: `'"post"' is not assignable to '"web" \| "phone"'` |
| a plain `string` picker on the union key | `NOVA3001` at the field's line: `'string' is not assignable to '"web" \| "phone"'` |
| a generic field whose parameter is not the value type | `NOVA3001` at the field's line — the type argument does not satisfy its constraint |
| a generic field needing two type arguments | `NOVA2012` at the field's line |
| a `NumberField` on a `string` key | the component's own `onChange` decides |
| a `name:` the action does not accept | three type errors on one line, all remapped to it |

A **section** component may be generic too, and there nova has no type argument to give —
its parameter is resolved by ordinary inference from the props the spec binds. That works
where the parameter is reachable from a bound prop (`rows: data#orders` fixing a table's
row type); it does *not* work where the parameter appears only in a mapped or conditional
prop type. See [limitations](#limitations).

## Actions and sorting

`confirm:` on a section guards the one action that section runs, whether through `submit:`
or through an ordinary prop binding:

```yaml
- DeleteButton: { label: Delete, onDelete: actions#deleteOrder, confirm: Delete this order? }
```

It is consumed by nova rather than forwarded, so a delete button needs no `confirm` prop of
its own. A page hoists one `useAction` per action, so two sections asking for different text
on the same action is `NOVA1010`; a `confirm:` with no action to guard, or with more than
one, is `NOVA1007`.

**An `actions#` binding on an ordinary prop is checked against the action's own input type,
and resolves the action's own result.** It reaches the component as `deleteOrderAction.run`,
and the page hoists that as
`useAction<DeleteOrderInput, Awaited<ReturnType<DeleteOrder>>>(…)`, so `run` takes the
action's declared input and resolves its declared result, or `null`:

```yaml
- ActivityList: { rows: data#orders, onDelete: actions#deleteOrder }
```

```tsx
// `onDelete`'s parameter decides whether the action may be bound at all: `Order` must be
// assignable to DeleteOrderInput. Its return type is what the component may read.
export function ActivityList(props: {
  rows: readonly Order[];
  onDelete: (row: Order) => Promise<{ ok: boolean; warning?: string } | null>;
}): React.ReactElement { … }
```

A component shared by several actions declares the payload it carries and is generic in it
— `payload: T; onDelete: (input: T) => Promise<R>` — so the action and the data the
component was given have to agree. A mismatch is `NOVA3001` at the section's own line.

**`null` is the action having given no answer** — the `confirm:` was declined, or the
request failed — and the message for that case is in `error` on the same hook. Everything
else is the action's own return value, parsed from the response body, so an action
declaring three outcomes hands the component three outcomes:

```ts
// actions.ts — the upstream accepted the order but had something to say about it.
export async function submitOrder(input: { id: string }): Promise<
  { ok: true; warning?: string } | { ok: false; fieldErrors: Record<string, string> }
> { … }
```

The value crosses HTTP: it is the JSON of what your action returned, so a `Date` in the
result arrives as a string, and a result carrying no `ok` key at all is treated as not-ok
(no `refreshes:` runs, and `fieldErrors` is read from it if present).

`sortable:` marks which of a section's columns the reader may sort by. Nova owns the sort
state and its round trip through the URL — `?sort=` and `?dir=`, beside the filters — and
hands the component `sort` and `onSort`; ordering the rows is the component's own job.

```yaml
- Table: { rows: data#orders, columns: [date, total], sortable: [date, total] }
```

A page holds one sort state, so a second sortable section is `NOVA1011`. A sortable column
that is not a key of the row type the section's loader returns is a `NOVA3001` at the
`sortable:` line — checked against the type, so a catalog is free to call its column prop
`cols`, `headers` or anything else. `NOVA1009` is the same question answered from the
spec's own text alone, before any type is read, and applies where the section names a
literal `columns:` list.

**A literal `columns:` or `numeric:` list is checked the same way.** They are ordinary
props — nova forwards them and your component decides what they mean — but they are the
two names a column list is written under by default (see `columnProps`), and a name in one
of them that is not a key of the row type is the same `NOVA3001` at that list's line.

The row type is taken from the one value the section reads from a loader, **including the
path into it**: `rows: data#order.lines` is checked against the element type of
`Order["lines"]`, not of `Order`. A section reading two different loader values is not
checked — there is no single row type the columns belong to, and nova will not pick — and
neither is one whose data is not a list of objects.

### Sorting what the browser does not hold

Ordering the rows is the component's job **as long as the component has all the rows**.
For a table showing page 2 of 88, sorting the 25 rows on screen is a wrong answer about
6,480, so sort state has to reach the loader — and it does, on exactly the terms a filter
value does:

```ts
// data.ts — the signature is the opt-in.
export async function shipments(input: {
  region: string;                  // a route param or a filter, as ever
  page: string;
  sort: string;                    // the column, "" when nothing is sorted
  dir: "asc" | "desc";             // "asc" when nothing is sorted
}): Promise<Shipment[]> { … }
```

A loader whose input names `sort` and/or `dir` is given the page's sort state and is
re-requested when it changes. A loader that names neither is not, and sorts in the browser
— which is right for a table that holds all its rows.

The declaration lives in the loader's signature rather than in the YAML because that is
where the fact belongs: the function that has to honour the ordering is the one that says
it can, and the keys are then checked against the loader's input like every other one. A
loader that asks for `sort` on a page that has none is the same "missing property"
`NOVA3001` as a loader asking for a filter the page does not declare.

Because those two names are nova's, a page that declares a filter called `sort` or `dir`
*and* has a sortable section is `NOVA1014` — two owners for one query parameter. Without a
sortable section on the page the names are yours.

### Refreshing after an action

`refreshes:` names the loaders a successful action invalidates, so the saved row appears
without a reload:

```yaml
- Form: { submit: actions#saveOrder, refreshes: [orders], fields: [ … ] }
```

Each name is resolved against the loaders that page's own sections bind, so
`refreshes: [odrers]` is `NOVA1012` at that line rather than a page that silently never
refreshes. It attaches to the one action the section runs — `NOVA1007` if there is not
exactly one, exactly as `confirm:` — and runs only when the action reports `ok: true`. There
is no cache and no key space behind it: it calls `reload()` on each named loader.

### Reading a dataset too big to send

Nothing here is new vocabulary; it is the pieces above in the arrangement a report wants.

**Pagination** is a filter and a second loader: `page: { default: "1" }` feeds the rows
loader, and a `pageCount` loader declaring the same scope feeds the pager. The filter setter
(`filters.page.set`) is what the pager calls.

**Sorting** such a table means declaring `sort` and `dir` in the rows loader's input — see
[above](#sorting-what-the-browser-does-not-hold).

**Export** — CSV, PDF, anything that is not JSON — is a route you write. Generated handlers
answer `Response.json` only. The spec's contribution is handing the filter values to a
component that builds the URL:

```yaml
- CsvLink: { endpoint: /reports/export.csv, scope: filters.region, span: filters.quarter }
```

so the export sees exactly the filters that component was handed, and nothing about the sort
unless you pass that too.

## What nova renders itself

Every component in a generated page is yours, but a few of them nova constructs rather than
forwards a spec's props to, so their shapes are a contract. A component that does not match
is a `NOVA3001` on every use, which is a poor way to discover it.

| Where | What nova writes | What your component must declare |
| --- | --- | --- |
| `shell` | `<PageShell title={"Orders"}>` … `</PageShell>` around the page | `title?: string` (omitted for a page with no `title:`) and `children` |
| `states.loading` | `<Loading />`, once per waiting section | every prop optional — it is given none at all |
| `states.error` | `<ErrorNotice>{message}</ErrorNotice>`, in place of the failed section | `children` — the message is not a prop |
| a form shell (`submit:`) | `busy`, `error`, `onSubmit`, its fields as children | `busy: boolean`, `error: string \| null`, `onSubmit: () => Promise<boolean>`, `children` |
| a field (`fields:`) | `value`, `onChange`, `error`, **and `name`** | `name: string`, `value`/`onChange` at that input key's own type, `error?: string` |
| a sortable section (`sortable:`) | `sort`, `onSort`, and `sortable` itself | `sort: { column: string; direction: "asc" \| "desc" } \| null`, `onSort: (column: string) => void`, `sortable: string[]` |

A field's `name` is both the wiring and an ordinary prop: nova uses it as the key of the
action's input **and** forwards it, because a field almost always wants it for its label's
`htmlFor`. Declare `name: string` on every field component.

### Keys nova reads

Under a section, these keys are spec vocabulary rather than props. The list is exhaustive;
everything else you write is forwarded.

| Key | Forwarded? | What it means |
| --- | --- | --- |
| `submit:` | no | the action this section's form submits — this is what makes it a form |
| `fields:` | no, **when `submit:` is present** | the form's inputs |
| `confirm:` | no | the message shown before the one action this section runs |
| `refreshes:` | no | the loaders a successful action invalidates |
| `children:` | no | nested sections |
| `initial:` (on a field) | no | that field's starting value |
| `sortable:` | **yes** | the sortable columns — wiring *and* a prop the component reads |

`fields:` is conditional because it is an ordinary prop name for a read-only component (a
roster, a column list): on a section with no `submit:` it is forwarded like anything else
and the component's own type decides. A form that genuinely forgot its `submit:` is then a
`NOVA3001` at that section rather than a spec error nova asserts from the key's name.

`submit:`, `confirm:`, `refreshes:` and `children:` have no such escape. A component
wanting a prop by one of those names has to be wrapped, or the prop renamed.

`states.empty` is optional and no generated page renders it. A section knows whether its own
rows are empty and nova does not, so the empty state belongs to your table as an ordinary
`empty:` prop of it. Where `states.empty` is given it is still resolved against the catalog,
so a name that does not exist is still a build error; that is the whole of what it does.

## Failing well

**A page degrades one section at a time.** Each section that binds a loader renders behind
its own conditional — the error state where that section's data failed, the loading state
where it has not arrived, the section itself otherwise — and a section that binds no loader
is not gated at all:

```tsx
<PageShell title={"Orders"}>
  <Toolbar … />                                           {/* chrome: always rendered */}
  {stats.error !== null ? <ErrorNotice>{stats.error}</ErrorNotice>
    : stats.value === null ? <Loading /> : <StatCards stats={stats.value} />}
  {orders.error !== null ? <ErrorNotice>{orders.error}</ErrorNotice>
    : orders.value === null ? <Loading /> : <Table rows={orders.value} … />}
</PageShell>
```

So one failing loader costs one section, not the page, and a page's first paint is its
chrome with a spinner where the data goes.

**One loader's failure is stated once.** The section is the unit that degrades; it is not
the unit a failure is *reported* in. The first section that binds a loader renders the
notice, and a later section whose data failed for the same reason renders nothing — it has
no data, and the reason is already on the screen above it. The **loading** state is
deliberately not deduplicated: four spinners in four places is what a page still arriving
looks like, whereas four copies of one sentence is one fact asserted four times.

**And stated at least once.** "Already on the screen above it" is not automatic when the
section that stated it is nested inside a section gated by a *different* loader: that parent
renders its own notice instead of its children, so the announcement is inside something
nobody can see. An announcement made from inside a gate is therefore remembered together
with the condition under which it is visible, and a later section binding the same failed
loader states the failure itself when that condition does not hold:

```tsx
{orders.error !== null
  ? (heading.error === null && heading.value !== null ? null   {/* said inside the Panel */}
     : <ErrorNotice>{orders.error}</ErrorNotice>)              {/* the Panel is not there */}
  : orders.value === null ? <Loading /> : <SummaryTable rows={orders.value} … />}
```

Exactly one notice per failed loader in every combination — the deduplication is conditional
rather than positional.

**A section that holds controls should not bind data it does not need.** If the card
carrying your date pickers also binds the report those pickers scope, a bad date range takes
the card with it and the reader has no way left to correct the range. Where the controls do
not actually need that data, the fix is one line of YAML: put them in their own section,
which binds no loader and is therefore never gated. Where the controls genuinely need the
data — a picker whose customer list 403s — splitting does not help; see
[limitations](#limitations).

`.value` is narrowed: the conditional is written one loader at a time so that `orders.value`
is non-null in the branch that reads it. Nothing is asserted or cast, so a prop bound to the
wrong type is still a `NOVA3001` at the spec line that bound it.

**A loader or action decides what its failure is worth.** A generated handler answers with
the status a thrown value asks for:

```ts
// data.ts — a stale link is a stale link, not a server fault
if (rows.length === 0) {
  throw Object.assign(new Error("This order no longer exists."), { status: 404 });
}
```

A numeric `status` between 400 and 599 is answered as `{ ok: false, error: <message> }` with
that status. **Anything else is re-thrown unchanged**, so an unexpected fault still reaches
your host's own error handling rather than a 500 nova invented. The page shows the message
the loader wrote, falling back to `404 Not Found` when the body carries none.

A loader that has nothing to return cannot express it by resolving to `null` — that is the
loading state — so this throw is how "not found" is said.

**A malformed request body is a 400.** `await req.json()` rejects on a body that is not
JSON; that is the caller's mistake, and the generated action handler answers
`400 {"ok":false,"error":"invalid JSON body"}` rather than letting it surface as a server
error. So is a body that parses but is not an object — `null`, `12`, `"order"`, `true` — since
an action's declared input is an object type, which is exactly what the `as never` at the
handler boundary asserts.

## Loader inputs

A loader's input object is assembled from the page's route params, its filter values and
(where the loader asks for them) its sort state, and is checked against the loader's own
declared parameter type. If a loader declares `{ month: string; region: string }` and the
page supplies neither, that is a `NOVA3001` at the spec line that named the loader. Where a
route param and a filter share a name, the route param wins.

**A loader is given the keys it declares, and no others.** A loader declaring
`{ region: string }` on a page with three filters is called with `{ region }` alone, and is
therefore re-requested when `region` changes and not when the other two do; a loader
declaring no parameters at all is called with no argument and is never re-requested by a
filter. That matters as soon as a page has more than a loader or two.

The narrowing needs a closed set of keys to read. Where the parameter type has none — an
index signature (`Record<string, string>`), a primitive, a bare type parameter — the whole
set is passed.

Filter values are **always strings**, because they live in the query string. A loader that
wants a number parses it (`Math.max(1, Number(input.page) || 1)`), and a filter's `default:`
is written as one (`page: { default: "1" }`). Nova does not coerce.

It does check that you did not say otherwise. The generated handler calls
`data.x(Object.fromEntries(searchParams) as never)`, so every value a loader can receive is a
`string` — and a loader declaring `limit: number` would be handed `"25"`, with
`input.limit > 10` comparing a string to a number and nothing anywhere saying so. An input key
whose declared type a string can never be is `NOVA2017`, reported at the loader's own
declaration in `data.ts`, because that is the line to edit. A type a string *can* be is left
alone, including a union that merely narrows it: `dir: "asc" | "desc"` is how the sorting
section above says to declare a sort direction.

The **action** half of the same boundary is not checked, and cannot be from a type alone: an
action receives an arbitrary JSON body, asserted into its declared input after nothing but an
"is it an object" test. `POST /_actions/<name>` performs **no input validation** — an action
declaring `{ orderId: string; quantity: number }` will be called with `{}` if a caller
sends `{}`. Validate inside the action, and do not expose generated action endpoints to any
caller the host does not already trust.

Generated code is safe under `noUncheckedIndexedAccess`. Filter values are keyed by the
filter names the page declares rather than by an open index signature, and each route param a
page reads is narrowed into a local once at the top of the page function.

## Diagnostics

Codes are stable; message wording is not. Assert on `code`.

- **`NOVA1xxx` — a problem in the spec file itself** (YAML syntax, schema shape, unknown or
  missing keys), answered from the document's own text with no catalog or type information.

  | Code | Meaning |
  | --- | --- |
  | `NOVA1000` | the YAML does not parse |
  | `NOVA1001` | an unknown key, or a prop nova itself supplies (a form's `busy`/`error`/`onSubmit`, a field's `value`/`onChange`/`error`, a sortable section's `sort`/`onSort`) |
  | `NOVA1002` | a missing required key |
  | `NOVA1003` | a key of the wrong shape |
  | `NOVA1004` | not a component reference |
  | `NOVA1005` | an invalid route |
  | `NOVA1006` | no `app.yaml` in the app folder |
  | `NOVA1007` | a `confirm:` or `refreshes:` with other than exactly one action to attach to |
  | `NOVA1008` | two fields editing the same key |
  | `NOVA1009` | a sortable column the section's own literal `columns:` list does not have — the spec-text half of that check; the type-derived half is a `NOVA3001` |
  | `NOVA1010` | one page binding the same action in two ways nova cannot reconcile — two different `confirm:` messages or `refreshes:` lists, or two forms on one action |
  | `NOVA1011` | more than one sortable section on a page |
  | `NOVA1012` | a `refreshes:` naming a loader that page's own sections do not bind |
  | `NOVA1013` | a filter `default:` bound to a namespace other than `compute#` |
  | `NOVA1014` | a page declaring a filter named `sort` or `dir` while also having a sortable section — `?sort=` and `?dir=` are nova's own two query parameters |

- **`NOVA2xxx` — name resolution, and the facts about your `NovaConfig` and your toolchain
  that name resolution depends on.**

  | Code | Meaning |
  | --- | --- |
  | `NOVA2000` | a `components:` entry that does not resolve |
  | `NOVA2001` | an unknown component |
  | `NOVA2002` | `data.ts` has no such export |
  | `NOVA2003` | `actions.ts` has no such export |
  | `NOVA2004` | `compute.ts` has no such export |
  | `NOVA2005` | a `params.` reference the route does not declare |
  | `NOVA2006` | a `filters.` reference the page does not declare |
  | `NOVA2007` | a local component module (`./views/charts#Chart`) that cannot be resolved |
  | `NOVA2008` | a local module with no component export of that name |
  | `NOVA2009` | the spec binds one name two ways — a component name bound to two modules, or a loader and an action sharing a name |
  | `NOVA2010` | two *catalogs* both export a component of that name — a fact about `components:` rather than about the spec, so it is reported at the top of `app.yaml` with both declarations in `related` |
  | `NOVA2011` | a `tsconfigPath` that does not parse |
  | `NOVA2012` | a field component needing more than one type argument; nova has exactly one to give (the type of the input key it edits), and a parameter left to inference is a parameter whose constraints may silently stop applying |
  | `NOVA2013` | a resolved `typescript` that does not provide the compiler API nova drives — a TypeScript 7 pulled in past the peer range, or a linked or aliased copy a range cannot reach. It names the version and the missing entry points |
  | `NOVA2014` | a `NovaConfig` field that is missing or of the wrong type. Every field is checked before it is used and every problem is reported in one run |
  | `NOVA2015` | an app module whose filename differs in case from `data.ts`, `actions.ts` or `compute.ts` — the one kind of resolution a case-insensitive filesystem answers `yes` to and a case-sensitive one does not |
  | `NOVA2016` | a file at one of the six output names that nova did not write, answered at the moment the write would have destroyed it |
  | `NOVA2017` | a loader input key whose declared type a string can never be: the generated handler can only ever pass strings, so the loader's own signature is what disagrees |

- **`NOVA3xxx` — a problem TypeScript found in the emitted output.** `NOVA3001` is remapped
  back to the YAML line that produced it, with the generated location in `related`.
  `NOVA3002` is reported at the generated location instead, because it has no traceable spec
  origin — that covers not only type errors but syntactic problems in the generated code.
  `NOVA3002` means only that nova could not trace the problem back to a spec line. It is
  *often* a nova bug and worth reporting as one, but three ordinary misconfigurations produce
  it in bulk and none of them is: `moduleResolution: "node16"` without
  `importExtension: ".js"`, a tsconfig without `lib: ["DOM"]` (both documented above), and a
  `tsconfig.json` whose `strict` flags reject code nova emits. Read the message first.

## Limitations

Ordered by how likely you are to hit them.

**Generated action endpoints perform no input validation.** An action's body is arbitrary
JSON, asserted into its declared input after nothing but an "is it an object" test — see
[loader inputs](#loader-inputs). Validate at the top of every action that does anything
consequential, and do not expose these endpoints to any caller the host does not already
trust. There is no spec-declared input shape to coerce against; that is a design nova does
not have.

**A form's starting values are literals, applied once.** `initial:` takes a literal, so a form
cannot be prefilled from a loader — an edit form that opens on an existing record is not
expressible. `useForm` seeds its state on first render and does not re-seed.

**A form cannot bind an optional key of the action's input.** `values["note"]` for
`note?: string` is `string | undefined`, so a field component declaring `value: string` will
not accept it. Either the field accepts `undefined` or the action declares the key required.

**Loading is inferred from `value === null`, not from `state.loading`.** A loader that
legitimately resolves to `null` — `Promise<Order | null>`, an ordinary signature — pins its
section on the loading state forever. Throw a `status`-carrying error instead (see
[failing well](#failing-well)). The `loading` flag `useLoader` maintains is read by no
generated page.

**Class components are not recognised.** Nova detects a component by checking for a call
signature; a class export has a construct signature instead, so it is filtered out of the
catalog before name resolution sees it, and naming it produces the same "unknown component"
error as a typo. Function and `forwardRef` components both work.

**A section is the unit that degrades, not a binding.** A section renders its error state
where *any* loader it binds failed and its loading state where any has not answered, so two
loaders on one section share a fate. Nothing renders half a section: a section cannot say
"show the table without the total".

**A refetch shows the previous answer, with nothing saying so.** `useLoader` keeps its last
value while re-requesting, and no generated page reads the `loading` flag, so changing a
filter leaves each affected section showing the old numbers until the new ones land. Right for
one table — no spinner flash on every keystroke — thinner for a page of six, where several
sections are briefly wrong together.

**One sort state per page, and one form per action per page.** Sort state lives under
`?sort=`/`?dir=`, so a page holds exactly one (`NOVA1011`); a form's local is named after its
action, so one page cannot hold two forms on the same action (`NOVA1010`). Both are places
where nova reports rather than guesses.

**The runtime is vendored per app, so a runtime fix is an N-app diff.**
`generated/runtime.tsx` is a per-app copy of the hooks the app uses, committed. That is
what keeps generated code importing nothing from nova, and it means a defect in any of
those hooks is fixed by regenerating and reviewing one file per app rather than by bumping
a version — on a host with a few dozen apps, that is a few dozen regenerated files. Budget
a regenerate-and-review pass across every app for any nova upgrade whose notes mention
`runtime.tsx`, and treat the emitted stamp (which covers the compiler version) as the
thing that tells you which apps are behind. A `runtimeDir` config emitting one shared
runtime per repository would satisfy the same rule and is not in 0.2.0: it changes the
emitted module graph and the mounting contract.

**The typecheck covers only the spec-to-code seam.** `typecheckEmitted` reports diagnostics on
the files nova emits, not on your hand-written modules or catalog components — those already go
through your own `tsc`, editor and CI. An empty diagnostics array means the seam between the
spec and your code is clean; it does not mean the overall build is clean. The seam check lives
in `pages.tsx`, whose JSX binds every prop to the component and loader/action type the spec
references. `__contract.ts` is a narrower additional check over the **loaders** only: its
`XxxInput`/`Xxx` types are derived from the very loader they are assigned back to, so it cannot
catch a spec/code type mismatch (`pages.tsx` already does); it catches loader arity and a
loader that is not `async`. It binds no action, because an action's binding would have been an
expression assigned to its own type, which no assignability rule can reject.

**`write: false` performs no typecheck.** The full pipeline still runs in memory and
`result.files` is populated, but nothing reaches disk, so there is nothing for TypeScript to
check and the typecheck stage is skipped. `result.ok === true` under `write: false` means the
spec resolved and emitted; it is not a claim that the output type-checks. Only a `write: true`
run (the default) verifies that.

**A generic *section* component's type parameter is left to inference.** Nova writes a type
argument for a field, because it knows the one type a field is about; a section has no such
type. Where the parameter is reachable from a bound prop — `rows: data#orders` fixing a table's
row type — that works and the derived props are checked. Where it appears only inside a mapped
or conditional prop type (`toggles: Array<{ key: BooleanKeys<T> }>`), nothing infers it, it
resolves to its constraint, and the constraint accepts anything with no diagnostic to say so.
Bind such a component behind a non-generic local component.

**An action bound to a callback that takes more arguments than the action's input is not
rejected.** `run` takes one parameter, and a one-parameter function is assignable to a callback
type with two, so `onPick: (id: string, index: number) => void` accepts an action whose input is
a `string`. The first argument is checked; the rest are ignored, exactly as in ordinary
JavaScript.

**A loader cannot carry both a payload and a status, so a section cannot show its own failure
inline.** A handler answers either a value at 200 or `{ ok: false, error }` at the thrown
status, and `useLoader` discards the body of any non-2xx response and nulls its `value` — so
`error` and `value` are never both meaningful and the section is replaced wholesale. A section
holding controls the reader needs *in order to recover* — a customer picker whose list 403s,
beside the date pickers and the Run button — must therefore choose between the right status on
the wire and a usable page. The workaround is to return the failure inside the payload
(`{ customers: [], error }` at 200). Doing it properly is a spec-surface change and is
deliberately not in 0.2.0.

**An action refuses with a status, but not with per-field detail.** An action that throws
`Object.assign(new Error("You may not."), { status: 403 })` is answered with that status and
the sentence surfaces in `error`, which a form shell renders. What it cannot do is refuse *and*
return the `{ ok: false, fieldErrors }` envelope: a throw leaves only the form-level `error`,
and a returned rejection is always HTTP 200. Authorization is not validation, and the format
cannot yet say so in one answer.

**A computed filter default is not a server-decided value.** `compute#currentMonth` runs during
render in both processes rather than being resolved once on the server and handed to the client,
because nova emits no server-to-client data channel. Right for a clock-derived default, wrong
for anything a request would have to be asked for — a per-user preference, a tenant setting.
Those belong in a loader.

**Ambient declarations must live in a `.d.ts`.** Nova's programs are built from the files it
needs plus whatever those import, so a tsconfig's `include` set is not dragged in wholesale.
Ambient declaration files are the exception — nothing imports them, so every `.d.ts` matched by
`include` is added to every program, and globals, JSX namespace types and module augmentations
work as they do under your own `tsc`. Ambient declarations written in a plain non-module `.ts`
file are not picked up.

**The input hash does not cover source file contents.** The stamp in each emitted file's header
covers the spec source, the whole config value and the compiler version. It does not cover
`data.ts`, `actions.ts`, `compute.ts` or any catalog or component file, so it is not sufficient
on its own to safely skip recompilation when only those change.

## Requirements

Node ≥ 20, and TypeScript ≥ 5.5 and < 7 — a peer dependency, because nova uses yours, so its
answers match your own `tsc`.

The upper bound is real, not caution. TypeScript 7's main entry exports `version` and
`versionMajorMinor` and nothing else: the compiler API nova drives is not reachable through it.
Nova checks the TypeScript it actually resolved before it reads your spec and answers
`NOVA2013` naming the version and the missing entry points, rather than throwing out of its own
`node_modules`. 5.5 through 6.x are supported; `pnpm add -D typescript@6` if your project is on
7 for its own build.

Nova is ESM-only: `"type": "module"`, no `require` export condition. A CommonJS build script
cannot load it, and `require()` of an ESM module fails outright on Node 20.0–20.18 even though
those satisfy `engines`.

## Versions

**0.2.0 is the first published version.** 0.1.0 was never on the registry — it existed only as
unpublished tarballs while nova was developed against real applications — so there is
nothing to migrate from.
[`CHANGELOG.md`](CHANGELOG.md) records what changed before the first release, which is of
interest only if you are reading generated output from one of those unpublished builds.
