# Changelog

## 0.2.0 — first published version

The first release on npm. See the [README](README.md) for the format, the config and the
two mounted maps.

---

## Before the first release

0.1.0 was never published. It existed only as unpublished tarballs while nova was
developed against real applications: five conversions of existing apps, plus two
independent consumers built against the README alone. What follows is the record of what
those found. **It is not a migration guide** — nothing installed from npm can be behind
any of it. It is here for one reason: if you are reading generated output emitted by an
unpublished 0.1.0, this is what nova used to do differently.

### Type checks that did not exist

- **An `actions#` binding on an ordinary prop is checked against the action's input
  type.** `run` was `(input: unknown) => Promise<boolean>`, and an `unknown` parameter is
  assignable to every callback shape there is, so nothing about the payload of an action
  outside a form was ever checked. A component shared by several actions should be
  generic in the payload it already carries.
- **`run` resolves the action's own result, not `boolean`.** A boolean verdict could not
  carry an upstream that accepted a submission *and* reported something recoverable, so
  two of three conversions showed a persisted row as an outright failure with the list
  un-refreshed behind it. Component props bound to an action must declare a callback
  returning what the action returns (or `Promise<R>`, or `void`).
- **A generic field component is invoked with an explicit type argument** — the type of
  the action-input key it edits. A parameter no supplied prop mentions is inferred from
  nothing and resolves to its constraint, silently voiding every check derived from it. A
  field component's first type parameter must be the value it carries, and it must not
  need a second (`NOVA2012`). This also relaxed an older rule that a catalog component's
  props type must be non-generic, which was what made a union-typed action input
  unbindable at all.
- **A literal `columns:` or `numeric:` list is checked against the row type.**
  `columns: [totl]` compiled clean and rendered a column of en dashes on three
  pages. `columnProps` is the opt-out for a catalog whose `columns` prop carries labels
  rather than row keys.
- **A sortable column is checked against the row type**, not only against a literal
  `columns:` prop — so a catalog spelling it anything else now gets the check too.
- **A loader input key whose declared type a string can never be is `NOVA2017`.**
- **A filter named `sort` or `dir` beside a sortable section is `NOVA1014`.** Both wrote
  the same query parameter; it compiled and then fought itself in the browser.

### Correctness fixes

- **A relative `appDir` no longer disables the typecheck.** `typecheckEmitted` keyed its
  file map on a path built from `appDir` while TypeScript reports every file name
  absolute, so with a relative `appDir` the map matched nothing and *every* `NOVA3001`/
  `NOVA3002` was discarded — `ok: true` on output that does not compile. The README's own
  example passed a relative path.
- **Nova refuses to overwrite a file it did not write** (`NOVA2016`). It used to write all
  six output names unconditionally, so a hand-written `types.ts` under `outDir: "."` was
  destroyed silently.
- **Loading and error states moved from the page to the section.** A page no longer
  returns early; one failed loader out of five used to replace the navigation, the header,
  the stats, every section and both forms.
- **One failed loader renders one error notice**, not one per section binding it — and
  never zero, when the announcing section is nested inside a gate of its own.
- **A loader or action failure carries its own status.** A thrown value with a numeric
  `status` (400–599) becomes that status and `{ ok: false, error }`; anything without one
  is re-thrown unchanged.
- **`useAction` and `useLoader` show the refusal the code wrote**, instead of discarding a
  non-2xx body and reporting the bare status line.
- **A JSON body that parses to a non-object is a 400**, not a 500.
- **Emitted code compiles under `lib: ["ES2022", "DOM"]` with no `@types/node`.** A loader
  handler built its input with `Object.fromEntries(…searchParams.entries())`, and
  `URLSearchParams.entries()` is declared in `lib.dom.iterable.d.ts` and not in
  `lib.dom.d.ts` — so an ordinary browser-targeting tsconfig met `TS2339`, which nova
  reported against its own output as a `NOVA3002` hinted "likely a nova bug". It uses
  `URLSearchParams.forEach`, which is in plain `lib.dom`. Same object, same keys, same
  last-one-wins for a repeated parameter.
- **Filter and sort writes keep `location.hash`.** A hash-routed SPA lost its route on
  every filter change.
- **`outDir` may escape the app folder or be absolute.** The specifier back to `data.ts`
  was computed relative to `process.cwd()`.
- **A loader is called with the keys its own input declares.** A parameterless loader used
  to be handed the page's whole filter set and re-requested on every keystroke; a
  reporting page with three filters and seven loaders issued seven requests per click.
- **Sort state reaches a loader that declares `sort`/`dir`**, so a paginated table can sort
  the dataset rather than the 25 rows on screen.
- **`fields:` on a section with no `submit:` is an ordinary prop**, not an error.
- **A `Data.ts` on a case-folding filesystem is `NOVA2015`** rather than an emitted
  specifier only macOS and Windows resolve.
- **A TypeScript without the compiler API is `NOVA2013`**, and a missing or wrong-typed
  `NovaConfig` field is `NOVA2014`, rather than a `TypeError` or a `Debug Failure.` thrown
  from inside someone else's module.

### Emitted-output size

A leanness pass over what nova emits, on the arithmetic that a line in nova's source costs
once and a line in `generated/` costs once per app. Across the four apps that carried a
spec when it was measured, `generated/` went from 511, 479, 388 and 199 lines to 393, 374,
323 and 169 — between 15% and 23% each.

- `pages.tsx` no longer exports a `titles` map; `shell` is where a page's `title:` goes.
- `types.ts` no longer exports `${Cap}` for an action bound only by a form's `submit:`.
- `__contract.ts` binds only the loaders; the action binding it dropped was an expression
  assigned to its own type, which no assignability rule can reject.
- The emitted handler entries are one expression each.
- The reasoning behind each emitted hook lives in the compiler rather than in the string it
  emits — roughly 45 lines per app of identical prose gone from files marked "do not edit".
- `FilterSpec["default"]` is a `PropValue` rather than `unknown`, which affects only a
  consumer of `@desmondzee/nova/schema` that inspects a parsed spec.
