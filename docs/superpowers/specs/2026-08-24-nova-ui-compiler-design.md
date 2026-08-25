# Nova — UI Compiler Design

Status: draft for review
Date: 2026-08-24
Repo: `nova` (the library, published as `@desmondzee/nova`). First consumer: `external-apps` (Light Apps Platform).

---

## 1. Problem

The Light Apps Platform holds 38 apps in `apps/`. Measured across all `.ts`/`.tsx`
files under `apps/`:

| Layer | Lines | Share of non-test code |
| --- | ---: | ---: |
| **UI** (`views.tsx` + `views/`) | **56,173** | **41%** |
| `server/` | 24,404 | 18% |
| `lib/` | 23,108 | 17% |
| `handlers.ts` | 21,411 | 16% |
| `pages.tsx` | 422 | 0.3% |
| tests | 36,397 | — |
| **Total** | **173,223** | — |

Non-test app code is 136,826 lines. UI is the largest layer, larger than
`server/` and `lib/` combined. The listed layers account for 125,518 of those
lines; the remaining ~11,000 are app-root files that follow no directory
convention (`german-mileage/lib.ts`, `german-mileage/voucher.ts` and similar).

The UI is repetitive *and* inconsistently so. Counting files under `apps/*/views*`:

- 54 implement a loading state
- 53 use `useState`
- 52 use `useEffect`
- 44 hand-roll an empty state
- 43 hand-roll a `<table>`
- 38 write their own fetch call
- 34 write their own number formatting
- 39 uses of `window.confirm` across the repo
- 22 files each add/remove their own `window` event listeners (mostly modal Escape and click-outside)
- 6 files read filter state from `window.location.search` — so whether filters
  survive a page refresh depends on which app you are in
- 3 files guard against out-of-order async responses (`requestSeq`, `cancelled`);
  the other ~50 do not

The distribution makes the case sharper than the totals do. The twelve
mileage/per-diem apps sit at 1,706–2,134 UI lines each — `italian-mileage-per-diem`
2,134, `norwegian` 2,111, `german-mileage` 2,047, `danish` 1,973, `french` 1,939,
and so on. That is roughly 22,000 lines that are the same screen with a different
rate table and different country rules.

## 2. What this is

A **build-time compiler** that turns a declarative YAML description of an app's
UI into the `pages` and `handlers` maps the platform already mounts.

It compiles the UI layer only. It does not model Light's API, does not describe
queries, does not own pagination or retries, and does not render documents.

Nova ships **no components and no runtime**. Components live in the host
codebase. Every type check is performed by the host's own TypeScript rather than
reimplemented.

### It must generalise, and external-apps is one consumer

Nova targets **simple UI apps** as a class — internal tools, admin panels,
reporting screens, entry forms. The shape it assumes is deliberately small:

- pages made of sections
- data from typed async loaders
- mutations through typed actions
- components resolved by name from a host-supplied catalog

The Light Apps Platform is the first consumer and the source of the evidence in
§1, but nothing in nova may depend on it. Two rules enforce that, and they are
testable rather than aspirational.

**Rule 1 — nova contains no host knowledge.** No Light types, no Light URLs, no
`@platform/*` import, no framework name. Catalogs, loaders and actions all arrive
by configuration. If nova ever needs to know which framework the host uses, that
is a design failure, not a feature request.

**Rule 2 — emitted code contains no host-specific imports either.** Generated
files import only the catalog modules named in config, the app's own relative
files, and `react`. They import nothing from nova, and nothing from a host
framework package. The emitted shapes are expressed in Web-standard and React
types:

```ts
export const pages: Record<string, ComponentType<{ params: Record<string, string> }>>;
export const handlers: Record<
  string,
  (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>
>;
```

TypeScript is structural, so external-apps' `AppPages` and `AppHandlers` accept
those without nova ever knowing those type names exist. Adapting the output to a
host's mount contract is the host's job; in external-apps it costs nothing,
because `scripts/build-registry.ts` already generates the registry and can apply
the types there.

The practical test of both rules: nova's own test suite compiles specs against a
fixture catalog that has no relationship to Light, and passes.

### Explicitly not in scope

- A query or expression language in YAML.
- Replacing `manifest.json`. Identity, visibility, roles and the `lightApi`
  allowlist stay hand-written — who may see an app is not a rendering concern.
- Replacing the `pages` / `handlers` chokepoints. The compiler emits into them.
- Lifting the duplicated fetch plumbing out of `apps/*/server/light.ts`
  (4,394 lines across 17 apps). That is worth doing and is tracked in §11, but it
  is an ordinary refactor into `@platform/core` and needs no compiler. Precedent:
  the six payroll apps have 21-line `server/light.ts` files because
  `@platform/payroll` already did exactly this.
- 100% config. The target is that the common case is declarative and the
  uncommon case is a typed component reference.

## 3. Decisions

Each was made deliberately during design; the rationale is recorded because the
reasons matter more than the choices if circumstances change.

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Build-time codegen**, not runtime interpretation | Errors land in CI and in the editor; the diff is reviewable; `tsc` checks the seam between spec and hand-written code for free |
| D2 | **UI only** | UI is 41% of app code and the most repetitive layer. The risky parts of a broader compiler — modelling an API, a join language, pagination policy — are exactly where per-app reality resists config |
| D3 | **Components resolved by name from host catalogs**; nova ships no component interface | The host's component library *is* the schema. Adding a component needs no nova release |
| D4 | **Typed loaders in `data.ts`**; compiler generates client fetch *and* the thin handler | Types flow end to end with nothing asserted by hand |
| D5 | **TypeScript does all type checking**; the compiler remaps diagnostics to spec lines | Assignability rules (variance, optionality, subtyping) are correct for free, and there is no structural comparator to maintain |
| D6 | **One npm package, subpath exports, no root export**; `typescript` is a peer dependency | See §7.3 |
| D7 | **No distinction between "component library" and "escape hatch"** | Both are names resolved against modules. Promoting an app-local component to shared is moving a file and changing one path |
| D8 | **First target: `german-mileage`**, then its eleven siblings | ~22,000 lines of near-identical UI behind one format |
| D9 | **Generic to simple UI apps; emitted code carries no host imports** | external-apps is the first consumer, not the design target. Enforced by §2's two rules and a Light-free fixture suite |
| D10 | **Published as `@desmondzee/nova`** | `nova` and `nova-ui` are taken on npm by dormant 2022 packages; a scope keeps the name verbatim |

## 4. Architecture

```
nova (this repo)                     any host
────────────────                     ────────
@desmondzee/nova/schema    spec format,   nova.config.ts          names the catalogs
                      validator      <catalog modules>       the components
@desmondzee/nova/compile   validate,       apps/<slug>/app.yaml    the spec
                      read types,     apps/<slug>/data.ts     typed loaders
                      emit            apps/<slug>/actions.ts  typed mutations
                                      apps/<slug>/generated/  emitted, committed
```

Nova has two entry points and no runtime. Nothing from nova is in the server or
client bundle.

## 5. The spec format

Illustrative, drawn from `german-mileage`. The exact vocabulary will move during
implementation; the *binding model* in §6 is the part that is settled.

```yaml
# apps/german-mileage/app.yaml
pages:
  "/":
    title: Mileage & Per Diem
    filters:
      month: { default: "2026-08" }
    sections:
      - TabNav: { active: overview }
      - StatCard: { label: "This month", value: data#monthlyTotal }
      - Table:
          rows: data#trips
          columns: [date, from, to, km, amount]
          sortable: [date, km]
          empty: "No trips logged yet"
      - TravelForm:
          submit: actions#saveTravel
          fields:
            - DateField:   { name: date,    label: Date }
            - NumberField: { name: km,      label: "Distance (km)", initial: 0 }
            - TextField:   { name: purpose, label: Purpose }

  "/trip/:id":
    title: Trip
    sections:
      - Row: { label: "Distance", value: data#trip.km, numeric: true }
      - DeleteButton:
          label: Delete
          onSubmit: actions#deleteTrip
          confirm: "Delete this trip?"
```

**Two corrections to this example, made during implementation.** They are recorded
here rather than silently left in place, because a reader who copies this block is
entitled to have it work.

A filter is a **name and an optional `default`**, and nothing else. The original
example showed `month: { type: month, default: current }`, which reads as if `type`
selected a month widget and `current` resolved to the current month. Neither happened:
`type` was required and read by no part of the compiler — `month`, `select` and a typo
like `mnoth` all behaved identically — and `default: current` shipped the literal
four-character string `"current"` to the loader. `type` was removed rather than
half-built; a spec that still spells it now gets NOVA1001 "unknown key" instead of a
silent no-op.

`default` is a literal **or a `compute#` binding**, which the generated page calls for
the value: `month: { default: compute#currentMonth }`. That is the shape "the current
month" settled into. A sentinel (`current`, `today`, `startOfQuarter`) was rejected as a
vocabulary that is untyped, host-specific and endlessly extensible, and that would have
put a calendar inside the compiler; a binding reuses §6's machinery, is checked against
the `string` a filter holds, and leaves time handling in the app's own code. Only
`compute#` is admitted — a `data#` value is asynchronous and arrives after the filter has
already fed its own loader, and `params.`/`filters.` are page state that does not exist
yet at the moment a default is needed — so any other namespace is NOVA1013. The call is
evaluated during render in both processes; nova emits no server-to-client channel, so a
default that has to be *decided* on the server is a loader, not a default.

**There is no `- action:` section form.** A section's single key is a component
reference (§6.1), so the original `- action: { label, fn, confirm }` block does not
parse — `action` is lowercase and has no `#`, so it produces NOVA1004 "not a component
reference". An action reaches the page as a component prop bound to `actions#name`, as
shown above. `confirm:` is a key on that same section rather than a section of its own:

```yaml
- DeleteButton: { label: Delete, onSubmit: actions#deleteTrip, confirm: Delete this trip? }
```

It guards the one action the section runs, and is consumed by nova (it becomes
`useAction`'s `opts.confirm`) rather than forwarded as a prop.

Four things a page may contain:

1. **A component reference** — a name resolved against the catalogs (§6.1).
2. **A binding** — `data#x`, `actions#x`, `compute#x`, `params.id`, `filters.month`
   (read) or `filters.month.set` (write).
3. **A literal** — anything else.
4. **Nested children** — a component's children are the sections beneath it, and a
   form's `fields:` are children that nova also wires to the form's state.

### Interactions the format owns

These are declared, not written, because the survey in §1 shows them being
re-solved dozens of times, often inconsistently:

- **Loading and error states** for every `data#` binding (54 files today).
- **Empty states** (44 files today) — surveyed here, but *not* taken: a section
  knows whether its own rows are empty and nova does not, so this one stayed with
  the component (`states.empty` is optional config, checked and never rendered).
- **Re-reading what an action invalidated** (`refreshes: [trips]` on the section
  that runs the action). Added during implementation: every create-then-list app
  has the shape, and without it a saved row does not appear until a manual reload.
- **Confirmation before a destructive action** (`confirm:` on an action —
  39 `window.confirm` calls today).
- **Filter state, including its round trip through the URL** (6 of 38 apps do
  this today; the rest lose filters on refresh).
- **Out-of-order response guards** for loaders (3 of ~50 files do this today).
- **Form field wiring** — value, change, per-field errors returned by the action.
- **Sortable columns**, with the sort state in the URL beside the filters. Added
  during implementation: 43 files hand-roll a table and the real ones sort. Nova
  owns the state and its round trip only; ordering the rows stays the component's
  business under D3, exactly as pagination does.
- **Where a page's sections go.** Added during implementation: sections emitted into
  a bare `<></>`, so a host had no parent to hang vertical rhythm on and put a
  `mt-4 first:mt-0` inside every catalog component instead — a layout concern pushed
  down into components, and a convention each host would invent for itself. Nova now
  wraps every page (its loading and error states included) in a host-supplied
  `shell` component and hands it the page's `title:`. Under D3 that is still no
  component of nova's: the shell is a catalog name from config, resolved and checked
  like `states.loading`, and optional — without one the fragment is what it always
  was. It is also what retired the `titles` map: the title had nowhere to go, and now
  it has.

**The shape the last four settled into.** A section that carries `submit: actions#x` is
a form; its `fields:` each name a key of that action's input type. `filters.month.set` is
a filter reference in write mode. `sortable: [date, km]` marks a section's sortable
columns. Each of them is a key on an ordinary section rather than a new section kind, so
§6.1's rule holds unchanged: a section's single key is still a component reference, and
nova still ships no components.

The load-bearing part is that none of the checking is nova's. `useForm<XInput>` is
generic over `Parameters<typeof actions.x>[0]`, and each field emits `values["k"]`,
`set("k", v)` and `errors["k"]` against it — so a field naming a key the action does not
accept, a `NumberField` bound to a `string` key, and a form that fails to cover a required
key are all ordinary TypeScript errors, remapped by §7.2 to the field's or the form's own
line. This is D5 doing the work rather than a comparator nova maintains.

## 6. How names bind

Three namespaces, all resolved at compile time by reading the host's TypeScript.

### 6.1 Components — `Table`, `./views/charts#BridgeChart`

The host config lists catalog modules:

```ts
// external-apps/nova.config.ts
export default {
  components: [
    "@platform/ui/nova",
    "@platform/ui/travel",
    "@platform/ui/payroll",
  ],
  outDir: "generated",
};
```

This maps onto structure that already exists. `packages/ui/src/travel.tsx` (378
lines) already exports `Field`, `ErrorNotice`, `Loading`, `Row`,
`ComplianceItem`, `StatCard`, `Modal`, `SubmittedPill`, `TabNav`,
`DateHourField` and `AddressInput` — the geocoding autocomplete the twelve
mileage apps share. `packages/ui/src/payroll.tsx` is a second catalog for the
seven payroll apps. The spec format gives YAML names to catalogs the repo
already has.

At compile time nova runs a `ts.Program` over those modules, enumerates the
exported React components and reads each one's props type. From that it knows
which names are valid and what each accepts.

**A bare name must resolve to a catalog export.** An unresolved name is a build
error naming the catalogs searched and the closest available names. A component
that is app-local is referenced by path — `./views/charts#BridgeChart` — which
makes it visible in the spec and in review that the app has stepped outside the
shared library.

**Catalog modules must export components with explicit, named props types.** Inferred
props defeat introspection, and the emitted JSX has nothing to bind against. This is
enforced by a lint rule on the catalog files, not by nova, which reads a catalog export's
callability and nothing more.

**Revised during implementation: props types may be generic.** The original rule
forbade it, on the reasoning that a generic defeats introspection. It does not — nova
never reads a props type, it emits JSX and lets `tsc` check it, so a type parameter is
resolved by ordinary inference at the call site. Worse, the rule was actively harmful:
an action input narrowing a key (`vehicle: "car" | "van"`) could not be bound by any
non-generic field, because a picker declaring `onChange(value: string)` may emit
`"lorry"`, so the only way through was to widen the action's own input to `string` and
narrow inside it — losing the guarantee at exactly the place a spec compiler should be
adding one. A field generic in its value type (`ChoiceField<T extends string>`) binds the
union with nothing cast and nothing silenced: an option outside the union is still a
NOVA3001 at that field's spec line. `forwardRef` was already fine (it has a call
signature) and is likewise not forbidden.

**Revised again: a *field*’s type argument is written, not inferred.** Relaxing the rule
opened a hole of its own. A type parameter that none of the props nova supplies mentions
has nothing to infer from; it resolves to its constraint, and every type derived from it
— `BooleanKeys<T>`, `Record<T, string>` — stops constraining anything, with no diagnostic
to say the check has gone. The survey found `PolicyForm<TPolicy>` compiling with an
invented `toggles` key for exactly that reason. Nova knows the one type a field is about
— the type of the input key it edits — so it now writes it: `<ChoiceField<SaveTripInput["vehicle"]> … />`.
The rule that leaves behind is narrower and statable: **a generic field component is
generic in the value it carries**, one type parameter (extras must have defaults, or it
is NOVA2012). A *section* has no such type and is still left to inference, which is right
where the parameter is reachable from a bound prop (`rows: data#trips` fixing a table’s
row type) and is a known blind spot where it is not — see the README’s limitations.

### 6.2 Data — `data#trips`

The app writes typed loaders:

```ts
// apps/german-mileage/data.ts
import type { Trip } from "./lib";

export async function trips(input: { month: string }): Promise<Trip[]> { … }
export async function monthlyTotal(input: { month: string }): Promise<string> { … }
```

The compiler generates both ends: a `GET` handler entry that calls the loader,
and the client-side fetch, loading state, error state and race guard in the page.
Because the loader's return type is real TypeScript, `rows: data#trips` is
checked against the `Table` component's `rows` prop with no type asserted by hand.

Loader inputs are supplied from route params and filter values, checked against
the loader's parameter type.

### 6.3 Actions — `actions#saveTravel`

```ts
// apps/german-mileage/actions.ts
export async function saveTravel(input: TravelInput):
  Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> { … }
```

The compiler generates the `POST` handler entry, the client call, the busy state,
the confirmation dialog if `confirm:` is set, and the mapping of returned
`fieldErrors` onto form fields.

Every action needs its *input* type, and gets it the same derived way:
`export type SaveTravelInput = Parameters<typeof actions.saveTravel>[0]`. A form indexes
into it (`useForm<SaveTravelInput>`); an action bound to a plain prop is hoisted as
`useAction<SaveTravelInput>` so that `.run` is `(input: SaveTravelInput) => Promise<boolean>`.

**Revised during implementation: `run` used to take `unknown`.** No `Input` alias was
emitted for a prop-bound action, on the reasoning that only a form indexes into the
input. That made the one non-form action binding wholly unchecked: an `unknown` parameter
is assignable to *every* callback shape, so `onDelete={deleteTripAction.run}` type-checked
against `(row: Trip) => void`, `(id: string, n: number) => void` and
`(p: { year: number }) => void` alike. The alias costs one line per action in `types.ts`
and one import; what it buys is the ordinary contravariant check, reported at the spec
line that bound it. `run` is declared as a property rather than a method so that check is
contravariant rather than bivariant.

### 6.4 Pure functions — `compute#formatKm`

Pure, no HTTP, bundled into the client. For formatting and derivation.

### 6.5 The hand-written surface is not replaced

`handlers.ts` continues to exist and stays hand-written. The compiler emits
*additional* entries for the loaders and actions the spec names, merged into the
app's own handler map. An app can be half-compiled.

## 7. The compiler

### 7.1 Pipeline

`compileApp(dir, config) → { ok, diagnostics, emitted }`. It never throws for
user error; an exception means an internal invariant broke.

1. **Load** — parse `app.yaml` retaining line and column. The YAML dependency
   lives here, in `@desmondzee/nova/compile`; `@desmondzee/nova/schema` stays dependency-free by
   validating already-parsed values plus a position sidecar.
2. **Validate** — structural check. Unknown keys are errors, not warnings;
   typos are the most common spec bug and silence is the worst response.
3. **Resolve** — read the catalogs and the app's `data.ts` / `actions.ts` /
   `compute.ts`; bind every name.
4. **Emit** — write `generated/`.
5. **Typecheck** — run `tsc` over the emitted output and remap diagnostics.

### 7.2 Type checking by remapping

The emitted code is its own proof. Emitting

```tsx
<Table rows={data.trips} columns={["date", "km"]} />
```

and typechecking it *is* the props check — React's JSX typing does it. Likewise
for hand-written functions, a probe file that never runs:

```ts
// generated/__contract.ts
import type { SaveTravel } from "./types";
import * as actions from "../actions";
const _saveTravel: SaveTravel = actions.saveTravel;
```

TypeScript performs the assignability check, so variance is correct without a
comparator: an action may accept a supertype of what the form supplies and return
a subtype of what the page consumes.

The compiler's job is to translate the location. `generated/pages.tsx:47` becomes
`app.yaml:12`:

```
apps/german-mileage/app.yaml:12
  sections[2].Table.rows → data#trips
  expected  Array<{ date: string; km: number }>
  found     Array<{ date: string; distanceKm: number }>
```

**Requirement:** the emitter records a line map from each generated line to its
spec origin. Built in from the first emit, not retrofitted.

### 7.3 Packaging

One package, ESM only (the host is `"type": "module"` on Node 24), with subpath
exports and **no `"."` entry**:

```json
{
  "name": "@desmondzee/nova",
  "type": "module",
  "exports": {
    "./schema":  "./dist/schema/index.js",
    "./compile": "./dist/compile/index.js"
  },
  "peerDependencies": { "typescript": ">=5.5" }
}
```

Omitting the root export means `import { x } from "@desmondzee/nova"` fails to resolve, so
there is no barrel through which `@desmondzee/nova/compile` — and therefore the 9 MB
TypeScript compiler — could be reached from an app file and pulled into the Next
bundle. This is the same rule `middleware.ts:2` enforces today by comment for
`@platform/core`, whose barrel re-exports the Postgres driver and ajv; here the
package manifest enforces it mechanically.

`typescript` is a peer dependency for two reasons: the host already has 5.7.2, and
the compiler reads the host's own source, so it must use the same TypeScript that
`pnpm typecheck` uses or the two can disagree about one file.

### 7.4 Determinism

Emission is byte-deterministic. Regenerating an unchanged spec produces a zero
diff, so CI can fail when `generated/` is stale — the same shape as the existing
`check-spec-drift` gate. Generated files are **committed**: reviewers see what
ships, and no working tree silently disagrees with `main`.

Incrementality is a hash of (spec + catalog versions + compiler version) written
into the emitted header. Worth having because the typecheck stage boots a
`ts.Program`.

### 7.5 The emitted output is two modules, and one of them is not the client's

Under React Server Components a server module that imports a `"use client"` module
receives *client references* rather than values, so a route map exported from the
client half reads back as `{}` — the host matches no route and 404s silently. The
page components therefore live in `views.tsx` (`"use client"`) and the `pages`
map in `pages.tsx`, which carries no directive and imports the components
by name. (A `titles` map was emitted beside it until a page shell gave `title:` a place
inside the page; no consuming host ever mounted it.) That is the same split a hand-written app in such a host already uses.

Two consequences of the same fact, both of which cost a running app before they were
understood:

- **A client component is still server-rendered on first paint.** The runtime's
  hooks therefore seed their state from the spec's declared defaults and reconcile
  with `window.location` inside their effect, which runs only on the client.
  Reading a browser global in a `useState` initialiser is a 500, not a hydration
  warning.
- **The client half has to know where the app is mounted.** `basePath` prefixes the
  URLs the generated client fetches. The *keys* of `handlers` do not move with it:
  they are matched against the path remaining after the host's own mount.

### 7.6 Diagnostics

Flat `{ code, severity, message, file, line, col, hint?, related? }` with stable
codes (`NOVA1001`). Stable codes let the testkit assert on failures without
pinning message wording.

## 8. Integration into external-apps

Concrete changes required in the host, each independently reviewable:

1. **`nova.config.ts`** at the repo root — the catalog list and `outDir`.
2. **`packages/ui/src/nova.ts`** — the general catalog. Today
   `packages/ui/src/index.tsx` exports `Card`, `Button`, `Badge`, `PageHeader`,
   `EmptyState`, `SearchSelect`, `DatePicker`. It has **no `Table`, no filter bar,
   no form field**. Those must be written first, and `DESIGN.md` requires shared
   components to land in their own core PR.
3. **`scripts/build-registry.ts`** — for an app containing `app.yaml`, import
   `@/apps/<slug>/generated/pages` instead of `@/apps/<slug>/pages`, and merge the
   generated handler entries with the app's own, and apply the `AppPages` /
   `AppHandlers` types there — the emitted files carry no host imports (§2), so
   this is where the structural shapes acquire their platform names.
   `@desmondzee/nova/compile` is imported only here. `build-registry` runs under `tsx`
   as a separate process before `next build`, so it is never in Next's module
   graph.
4. **`eslint.config.mjs:77`** — the `apps/**` import allowlist currently permits
   `@platform/core|payroll|sdk|travel|ui`, `react` and `next`. It needs the
   catalog paths for generated files. Nothing from `@desmondzee/nova` is imported at
   runtime, so the package itself does not need adding.
5. **A lint rule on catalog modules** — exported components must have explicit,
   named props types (§6.1). Generic props types are permitted, and are how a field
   binds a union-typed key of an action's input.
6. **`generated/`, not `.generated/`** — a leading dot changes behaviour in
   tsconfig `include` globs, eslint's default ignores and npm packing at once, for
   no benefit.

## 9. Worked example: `german-mileage`

Chosen as the first target: 2,047 UI lines, and eleven siblings at 1,706–2,134
lines each behind it.

Today:

```
apps/german-mileage/
├── manifest.json
├── pages.tsx          12 lines — 4 routes
├── views.tsx       2,047 lines — MileageHomePage has 14 useState hooks
├── handlers.ts       815 lines
├── lib.ts
├── voucher.ts
└── migrations/       8 files
```

After:

```
apps/german-mileage/
├── manifest.json      unchanged
├── app.yaml           4 pages, sections, bindings
├── data.ts            typed loaders
├── actions.ts         typed mutations
├── lib.ts             unchanged
├── voucher.ts         unchanged
├── handlers.ts        what the spec does not cover
├── migrations/        unchanged
└── generated/         pages.tsx, views.tsx, handlers.ts, types.ts, runtime.tsx, __contract.ts
```

This app is deliberately not the easy case. It has geocoding autocomplete against
`photon.komoot.io`, route distances from OSRM, a per-day meal grid, multi-stop
entry, and a monthly submission flow. The geocoding component is already shared
as `AddressInput` in `packages/ui/src/travel.tsx`; the meal grid is a candidate
to move there, since twelve apps need it.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Props introspection defeated by inferred props | Lint rule on catalogs (§6.1). Generics and `forwardRef` turned out not to be a risk at all: nova never reads a props type — it emits JSX and lets `tsc` check it — so both resolve by ordinary inference at the call site |
| Escape hatches spread until specs are shells around custom React | The compiler reports each app's escaped share in build output; app-local components are referenced by path, so they are visible in the spec and in review |
| The format grows toward a programming language | Anything not expressible is a component reference. That is the pressure valve that keeps expressions out of YAML |
| `packages/ui` gaps block the first conversion | `Table`, filter bar and form field are prerequisites, sequenced first in §11 |
| Diagnostics point at generated files instead of the spec | The line map is a first-emit requirement, not a later improvement (§7.2) |
| Rewriting a working app introduces regressions | Each app has tests (36,397 lines across the repo); conversion must keep the existing suite green |

## 11. Scope and order of work

**v1 — the format proves itself on one app.**

1. `packages/ui`: add `Table`, filter bar, form field as a core PR. Independent of
   nova; unblocks everything.
2. nova: package skeleton, build and publish loop, `@desmondzee/nova/schema` with a
   position-aware validator, and the Light-free fixture catalog its tests compile
   against (§2, rule 1). The fixture suite exists from the first commit, so the
   generality constraint is checked continuously rather than audited later.
3. nova: `@desmondzee/nova/compile` — catalog introspection and name resolution.
4. nova: emit `pages.tsx` + `types.ts` with the line map; diagnostic remapping.
5. nova: loaders and actions — emit handler entries, client fetch, loading, error,
   race guard, confirm.
6. external-apps: `nova.config.ts`, `build-registry` wiring, eslint allowlist,
   catalog lint rule.
7. Convert `german-mileage`, keeping its existing test suite green.

**Then — the format pays for itself.**

8. Convert the eleven sibling mileage/per-diem apps.

**Deferred, in likely order.**

- Lift `RetryBudget` / `drain` / backoff from `apps/*/server/light.ts` into
  `@platform/core` (4,394 lines across 17 apps). Independent of the compiler.
- Convert a reporting app (`invoice-reporting`) to test the format against a
  second app shape.
- Charts, editable grids with keyboard navigation, paste-import and file upload
  stay as component references. Under ~1,600 lines across four apps
  (`fpa/views/charts.tsx` 270, `timesheet/views/week.tsx` 494,
  `fpa/views/plan.tsx` 686, `fpa/views/import.tsx` 134) — under 3% of UI. Each may
  graduate into a catalog later with no format change.
- A second consumer outside Light, which would justify a component registry with
  runtime resolution rather than compile-time paths.

## 12. Open questions

- **npm scope ownership.** `@desmondzee/nova` has no published package, but that does
  not prove the `@light` scope is unclaimed. Confirm before the first publish;
  `@light-space` matches the GitHub org and is the fallback.
- **The exact spec vocabulary** in §5. The binding model (§6) is settled; the
  surface syntax is not, and should be revised against `german-mileage` during
  step 7 rather than fixed now.
- **How much of `german-mileage`'s 815-line `handlers.ts`** the loader/action
  model absorbs. This is the main uncertainty in v1's size, and it will be
  answered by doing step 7 rather than by more design.
