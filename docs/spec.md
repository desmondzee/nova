# The nova model

A **spec** is one YAML file, `app.yaml`, describing an app's pages. The compiler reads
it together with three ordinary TypeScript modules you write — `data.ts` (async
loaders), `actions.ts` (mutations), `compute.ts` (plain functions) — and a **catalog** of
React components you already have, and emits six files: two React modules, an HTTP
handler map, a vendored runtime, a types module and a file that exists only to be
typechecked. Nova ships no components and emits no import of itself; every type check is
performed by your own TypeScript.

This document states the model. [`README.md`](../README.md) is the how-to, with worked
examples of every mechanism and the full list of limitations.

## One example, carried through

```
apps/orders/
├── app.yaml
├── data.ts       export async function orders(input: { month: string }): Promise<Order[]>
│                 export async function order(input: { id: string }): Promise<OrderDetail>
├── actions.ts    export async function saveOrder(input: OrderInput): Promise<…>
├── compute.ts    export function currentMonth(): string
└── generated/    the six emitted files
```

```yaml
# app.yaml
pages:
  "/":
    title: Orders
    filters:
      month: { default: compute#currentMonth }
    sections:
      - FilterBar: { label: Month, value: filters.month, onChange: filters.month.set }
      - Table:
          rows: data#orders
          columns: [date, total]
          sortable: [date, total]
          empty: No orders yet

  "/order/:id":
    title: Order
    sections:
      - Panel:
          heading: data#order.reference
          orderId: params.id
          children:
            - Table: { rows: data#order.lines, columns: [sku, qty] }
            - Form:
                submit: actions#saveOrder
                confirm: Save this order?
                refreshes: [order]
                fields:
                  - DateField:   { name: date,  label: Date }
                  - NumberField: { name: total, label: Total, initial: 0 }
            - ./views/charts#TotalsChart: { rows: data#order.lines }
```

`data.ts`, `actions.ts`, `compute.ts` and `app.yaml` are exact lowercase names, and the
case is checked rather than assumed (`NOVA2015`).

## Document shape

The spec's only top-level key is `pages:`, a mapping of route to page. A route is `/` or
a sequence of `/segment` parts, where a segment is `[A-Za-z0-9_-]+` or `:param`
(`NOVA1005`).

A page takes exactly three keys — `title:` (optional), `filters:` (optional) and
`sections:` (required). Anything else is `NOVA1001`.

A **section** is either a bare component reference (`- Table`), or a single-key mapping
whose one key is a component reference and whose body is that component's props
(`- Table: { rows: … }`). Two keys under one list item is an error, not two sections
(`NOVA1003`) — the single-key form is what makes the component name and its props one
node. A body of `null` means no props.

Under `children:` a section nests more sections, using exactly the same form, to any
depth. Nesting is structural only: a child is rendered inside its parent's JSX, and
inherits nothing from it except the parent's own visibility gate.

Every key under a section that is not in the reserved list below is forwarded to the
component as a prop, verbatim.

## Reference forms

Any *string* in a prop position, and any *key* in a section or field position, is
examined for one of these forms.

| Form | Binds to | Unresolved |
| --- | --- | --- |
| `data#orders`, `data#order.lines` | an export of `data.ts`; the dotted path indexes into its resolved result | `NOVA2002` |
| `actions#saveOrder` | an export of `actions.ts`. No dotted path is accepted | `NOVA2003` |
| `compute#currentMonth` | an export of `compute.ts`. No dotted path | `NOVA2004` |
| `params.id` | a `:id` parameter of that page's own route | `NOVA2005` |
| `filters.month` | a filter that page declares — read mode | `NOVA2006` |
| `filters.month.set` | the same filter, write mode: emits `(value: string) => void` | `NOVA2006` |
| `Table` (bare, capitalised) | a capitalised, callable export of a module listed in `components` | `NOVA2001` |
| `./views/charts#TotalsChart` | a capitalised, callable export of a module resolved relative to `app.yaml` | `NOVA2007` (module), `NOVA2008` (export) |

Precisely:

- A component reference is either a bare identifier starting with a capital, or
  `<specifier>#<Name>` where the specifier begins with `.`. A bare package specifier is
  not a component reference — catalog modules are named in config, not in the spec.
- Detection is by call signature, so a class export is not a component and reads as
  unknown.
- A name resolving to two different modules is `NOVA2009`; a name exported by two
  catalogs is `NOVA2010`; a loader, an action and a compute function may not share a
  name (`NOVA2009`).
- **A string that matches none of these forms is a plain string literal**, silently.
  `Data#orders`, `filters.month.value` and `compute#a.b` are strings, not typos with a
  diagnostic. Only a section or field *key* is required to be a component reference
  (`NOVA1004`).

## Reserved section keys

Everything else is forwarded. The list is exhaustive.

| Key | Forwarded | Meaning |
| --- | --- | --- |
| `submit:` | no | the `actions#` binding this section's form submits — this is what makes the section a form |
| `fields:` | no, **only when `submit:` is present** | the form's inputs |
| `confirm:` | no | text shown before the one action this section runs |
| `refreshes:` | no | loaders to re-read after that action succeeds |
| `children:` | no | nested sections |
| `sortable:` | **yes** | sortable column names — wiring *and* an ordinary prop |
| `initial:` (field only) | no | that field's starting value, default `""` |
| `name:` (field only) | **yes** | the key of the action's input this field edits |

`fields:` is the conditional one: without a `submit:` it is an ordinary prop name (a
roster, a column list) and is forwarded like anything else. The other four have no
escape — a component wanting a prop by one of those names must be wrapped.

`confirm:` and `refreshes:` each need exactly one action bound by the section, whether
through `submit:` or an ordinary prop; zero or more than one is `NOVA1007`. A
`refreshes:` naming something no section on the page loads is `NOVA1012`.

Props nova supplies itself may not also be written in the spec (`NOVA1001`): `busy`,
`error`, `onSubmit` on a form; `value`, `onChange`, `error` on a field; `sort`, `onSort`
on a sortable section. The shapes nova requires of those components are tabulated in the
README under [what nova renders itself](../README.md#what-nova-renders-itself).

One page holds one sort state (`NOVA1011`) and one form per action (`NOVA1010`).

## Filters

A filter is a name and an optional `default:`, and nothing else — there is no `type:`.
Its value lives in the query string, so it survives a refresh, and it is **always a
string**; nova performs no coercion.

A `default:` is either a literal (stringified) or a `compute#` binding, which nova
*calls* for the starting value — `compute#currentMonth` emits
`useFilters({ "month": compute.currentMonth() })`. Any other namespace is `NOVA1013`: a
`data#` value is asynchronous and arrives after the filter has already fed its loader,
and `params.`/`filters.` are page state that does not exist when a default is needed.
A computed default runs during render in both processes; keep it a pure function of the
clock.

`set` is a reserved filter name (`NOVA1001`). `sort` and `dir` are reserved on any page
that also has a sortable section, since those are the two query parameters nova's own
sort state uses (`NOVA1014`).

A loader is given exactly the input keys it declares, drawn from the page's route params
and filter values (route param wins on a name clash), plus `sort`/`dir` where the
loader's own signature names them. See [loader inputs](../README.md#loader-inputs).

## What is emitted

Six files, into `outDir`. Nova refuses to overwrite any file at those names that does not
carry its header, and refuses all six together (`NOVA2016`).

| File | Contents | Mounted by the host |
| --- | --- | --- |
| `pages.tsx` | `export const pages: Record<string, React.ComponentType<{ params: Record<string, string> }>>`, keyed by the route as written. **No** `"use client"` | **yes** |
| `handlers.ts` | `export const handlers: Record<string, (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>>`, keyed `"GET /_data/<loader>"` and `"POST /_actions/<action>"` | **yes** |
| `views.tsx` | `"use client"`; one `Page_<n>` component per route. Imported by `pages.tsx` | no |
| `runtime.tsx` | `"use client"`; a per-app copy of only the hooks this app uses — `useLoader`, `useFilters`, `useSort`, `useAction`, `useForm` | no |
| `types.ts` | aliases derived from your own signatures (`Parameters<typeof data.orders>[0]`, `Awaited<ReturnType<…>>`) | no |
| `__contract.ts` | typechecked, never executed. See below | no |

The `pages.tsx`/`views.tsx` split is load-bearing under React Server Components: a server
module importing a `"use client"` module receives client references, so a route map
exported from the client half reads back as `{}`.

**Nova ships no route matcher.** Matching a request path against `"/order/:id"` and
passing `params` is the host's job. `Request` and `Response` are the Fetch API's.
Handler keys are matched against the path *after* your mount; `basePath` moves only the
URLs the client fetches.

## What is typechecked, and what is not

Emitted output is typechecked by *your* TypeScript, against your `tsconfigPath`. There
are three seams, and they do not cover the same thing.

**Checked, and this is the main one.** `pages.tsx`'s JSX binds every spec prop to the
component's declared prop type and to the loader/action types it references. A prop bound
to the wrong type, a loader whose declared input the page cannot supply, a field naming a
key the action does not accept, a form not covering every required key, a `columns:` or
`sortable:` entry that is not a key of the row type — all are ordinary React JSX errors,
remapped back to the spec line that caused them as `NOVA3001`.

**Checked, narrowly.** `__contract.ts` restates each *loader*'s shape as
`(input: XInput) => Promise<X>`. Because both types are derived from the loader itself,
it cannot catch a spec/code mismatch — `pages.tsx` already does — but it does catch loader
arity and a loader that is not `async`. It binds no action, because an action's binding
would be an expression assigned to its own type, which no assignability rule can reject.

**Not checked — and this is the specific place a reader will guess wrong: the HTTP
boundary.** A loader is called with the query string and an action with the parsed JSON
body, and both cross into your typed function through `as never`. The action half performs
**no input validation** beyond "is it an object": an action declaring
`{ orderId: string; quantity: number }` will be called with `{}` if a caller sends `{}`.
Validate inside every consequential action, and do not expose these endpoints to a caller
the host does not already trust. The loader half is checked only in one direction —
`NOVA2017` reports an input key whose declared type a string can never be, at the loader's
own declaration.

Two further gaps worth knowing: only the files nova emits are reported on (your
hand-written modules and catalog components go through your own `tsc`), and
`compileApp(..., { write: false })` skips the typecheck stage entirely, so `ok: true`
there means "resolved and emitted", not "type-checks". A generic *section* component's
type parameter is also left to inference; nova writes a type argument only for a field.
The full list is in [limitations](../README.md#limitations).

## Diagnostic blocks

Codes are stable; message wording is not. Assert on `code`. Every diagnostic is
`{ code, severity, message, file, line, col, hint?, related? }`, and `compileApp` never
throws for a problem in your spec or config.

| Block | Answered from | Covers |
| --- | --- | --- |
| `NOVA1xxx` | the spec document alone — no catalog, no types | YAML syntax, shape, unknown and missing keys, reserved names, and whole-page consistency (`NOVA1000`–`NOVA1014`) |
| `NOVA2xxx` | name resolution, and the config and toolchain it depends on | unknown components and exports, unresolvable modules, name collisions, `NovaConfig` and `tsconfig` problems, the TypeScript version, refusing to overwrite (`NOVA2000`–`NOVA2017`) |
| `NOVA3xxx` | TypeScript, over the emitted files | `NOVA3001` traced back to the spec line that produced it, with the generated line in `related`; `NOVA3002` where no spec line can be traced, reported at the generated location |

`NOVA3002` means only that nova could not trace the problem to a spec line. It is often a
nova bug, but three ordinary misconfigurations produce it in bulk: `moduleResolution:
"node16"` without `importExtension: ".js"`, a tsconfig without `lib: ["DOM"]`, and
`strict` flags that reject emitted code. The code-by-code tables are in
[diagnostics](../README.md#diagnostics).

## Configuration

Nova reads no config from disk; you pass a `NovaConfig` to `compileApp`. Every field is
validated at runtime before use, and every problem is reported in one run as `NOVA2014`.

**Required**

- `components: string[]` — the catalogs. Module specifiers whose capitalised, callable
  exports a spec may name.
- `states: { loading, error, empty? }` — catalog component names. `loading` is rendered
  with no props and `error` with the message as `children`, once per waiting or failed
  section. `empty` is resolved but never rendered; a section knows whether its own rows
  are empty and nova does not.
- `outDir: string` — resolved against the app folder. May be nested, may escape it, may
  be absolute; import specifiers are computed from the resolved directories either way.
- `tsconfigPath: string` — used to resolve modules and to typecheck emitted output.

**Optional**

- `shell` — a catalog component wrapping every page, given the page's `title:` and the
  sections as `children`. Without one, sections emit into a bare fragment.
- `importExtension` — `""` (default, bundler resolution) or `".js"` (for
  `node16`/`nodenext`). Nothing else is accepted.
- `basePath` — prefixes the URLs the generated client fetches. Handler keys deliberately
  do not move with it.
- `columnProps` — defaults to `["columns", "numeric"]`; the props whose literal
  string-array value is checked against the row type. Set `[]` to opt out. `sortable:` is
  nova's own word and is checked regardless.

## Where this fits

Nova compresses repetition across a **family of near-identical apps** — the same screen
over a different lookup table and a different set of rules. The agent of compression is
the shared component catalog; the compiler's contribution is consistency — filters in the
URL, race guards, per-section degradation, one dispatch layer.

Measured across five converted production apps, the only group that shrank was the
largest: a dozen-plus entry-form apps over one catalog, at −23% for the first conversion
and −32% for the second. The other three groups were single conversions and grew (+6% to
+19%). For one screen, however complex, it costs more than it saves. The break-even point
is somewhere between the second app and the fourteenth and is not pinned more precisely;
the numbers and their caveats are in
[does this fit your problem?](../README.md#does-this-fit-your-problem).

It compiles the UI layer only. It does not model an API, describe queries, own pagination
or retries, or render documents.
