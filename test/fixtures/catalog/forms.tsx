import * as React from "react";

// A second Light-free fixture catalog, kept separate from ui.tsx so it can be added to
// a spec's `components` list without colliding with anything ui.tsx already exports.
// These three cover the prop shapes ui.tsx has no component for: children, a bound
// action callback, and a bound compute function.

export function Panel(props: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section aria-label={props.title}>
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

/**
 * A button that runs one action. Generic in the payload it submits, so the action's own
 * declared input type is what decides whether a `payload:` is acceptable — `onSubmit`
 * used to be declared `(input: unknown) => Promise<boolean>`, which every action there
 * is satisfied and nothing about the payload was ever checked.
 *
 * Generic in the *answer* too, for the same reason in the other direction: `Promise<
 * boolean>` no longer describes what an action resolves, and a button that does not read
 * the answer should not have to name it either.
 */
export function ActionButton<T, R>(props: {
  label: string;
  payload: T;
  onSubmit: (input: T) => Promise<R>;
}): React.ReactElement {
  return (
    <button type="button" onClick={() => void props.onSubmit(props.payload)}>
      {props.label}
    </button>
  );
}

// The form contract a host catalog has to satisfy: a form shell taking `onSubmit`,
// `busy` and `error`, and fields taking `name`, `value`, `onChange` and `error`. Field
// components differ only in the type they carry — which is exactly what makes a
// NumberField on a string input a compile error.

export function Form(props: {
  busy: boolean;
  error: string | null;
  onSubmit: () => Promise<boolean>;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      {props.error === null ? null : <p role="alert">{props.error}</p>}
      {props.children}
      <button type="button" disabled={props.busy} onClick={() => void props.onSubmit()}>
        Save
      </button>
    </section>
  );
}

export function TextField(props: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}): React.ReactElement {
  return (
    <label htmlFor={props.name}>
      {props.label}
      <button type="button" onClick={() => props.onChange(props.value)}>
        {props.value}
      </button>
      {props.error === undefined ? null : <em>{props.error}</em>}
    </label>
  );
}

export function DateField(props: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}): React.ReactElement {
  return <TextField {...props} />;
}

/** A field whose own props bind too — `options` comes from a loader. */
export function SelectField(props: {
  name: string;
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  error?: string;
}): React.ReactElement {
  return (
    <label htmlFor={props.name}>
      {props.label} ({props.options.length})
      <button type="button" onClick={() => props.onChange(props.value)}>
        {props.value}
      </button>
      {props.error === undefined ? null : <em>{props.error}</em>}
    </label>
  );
}

export function NumberField(props: {
  name: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  error?: string;
}): React.ReactElement {
  return (
    <label htmlFor={props.name}>
      {props.label}
      <button type="button" onClick={() => props.onChange(props.value)}>
        {props.value}
      </button>
      {props.error === undefined ? null : <em>{props.error}</em>}
    </label>
  );
}

/** A filter widget: reads one filter value and writes it back. */
export function FilterBar(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <label>
      {props.label}
      <button type="button" onClick={() => props.onChange(props.value)}>
        {props.value}
      </button>
    </label>
  );
}

export function Formatter(props: {
  label: string;
  value: number;
  format: (n: number) => string;
}): React.ReactElement {
  return (
    <p>
      {props.label}: {props.format(props.value)}
    </p>
  );
}

/**
 * A table that sorts its own rows. Nova owns the sort state and its round trip through
 * the URL; which header is clickable and how the rows are ordered stay the component's
 * business (D3). `sort`'s shape is declared here, by the host — nova ships no types.
 */
export function SortableTable(props: {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  sortable: string[];
  sort: { column: string; direction: "asc" | "desc" } | null;
  onSort: (column: string) => void;
}): React.ReactElement {
  return (
    <table data-sort={props.sort === null ? "" : `${props.sort.column}:${props.sort.direction}`}>
      <thead>
        <tr>
          {props.columns.map((c) => (
            <th key={c}>
              {props.sortable.includes(c) ? (
                <button type="button" onClick={() => props.onSort(c)}>
                  {c}
                </button>
              ) : (
                c
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{props.rows.length}</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * A picker generic in the value it carries. `T` is inferred from the key the field is
 * bound to *and* from `options`, so binding it to a union-typed key of an action's input
 * works and an option outside that union is still a type error.
 */
export function ChoiceField<T extends string>(props: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  error?: string;
}): React.ReactElement {
  return (
    <label htmlFor={props.name}>
      {props.label}
      {props.options.map((o) => (
        <button key={o.value} type="button" onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
      {props.error === undefined ? null : <em>{props.error}</em>}
    </label>
  );
}

/**
 * A table with a per-row action — the shape the survey found across every app in the
 * corpus, and the one an `actions#` binding outside a form reaches. `onDelete` takes the
 * row, so the action bound to it has to accept a row.
 */
export function RowActions(props: {
  rows: ReadonlyArray<{ id: string; date: string }>;
  onDelete: (row: { id: string; date: string }) => void;
}): React.ReactElement {
  return (
    <ul>
      {props.rows.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => props.onDelete(r)}>
            {r.date}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Keys of `T` that hold booleans — the only kind a toggle can drive. */
type BooleanKeys<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T] & string;

/**
 * A field generic in a *record* rather than in the value it carries: `T` appears only
 * inside `keys`, through a mapped type, so nothing nova supplies can infer it. Invoked
 * with no type argument, `BooleanKeys<T>` accepts any string at all and the check the
 * generic exists for is silently gone — which is why nova writes the type argument for a
 * generic field, and why a field component that is not generic in its value fails.
 */
export function ToggleGroupField<T extends object>(props: {
  name: string;
  label: string;
  keys: ReadonlyArray<BooleanKeys<T>>;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}): React.ReactElement {
  return (
    <label htmlFor={props.name}>
      {props.label}
      <button type="button" onClick={() => props.onChange(props.value)}>
        {props.keys.join(",")}
      </button>
      {props.error === undefined ? null : <em>{props.error}</em>}
    </label>
  );
}

/**
 * A field asking for two type arguments. Nova has exactly one to give — the type of the
 * input key the field edits — and a type parameter it leaves to inference is a parameter
 * whose constraints may quietly stop applying, so this is reported (NOVA2012) rather than
 * emitted half-instantiated.
 */
export function PairField<A extends string, B extends string>(props: {
  name: string;
  label: string;
  value: A;
  onChange: (value: A) => void;
  hints: readonly B[];
  error?: string;
}): React.ReactElement {
  return (
    <label htmlFor={props.name}>
      {props.label}
      <button type="button" onClick={() => props.onChange(props.value)}>
        {props.hints.join(",")}
      </button>
      {props.error === undefined ? null : <em>{props.error}</em>}
    </label>
  );
}

/**
 * A section that runs one action and reports what came back. Its `onSend` declares the
 * action's own three outcomes, so a warning the upstream returned alongside a success is
 * something the component can show — which it cannot do if all it is handed is `true`.
 * `null` is the action having no answer: a declined confirmation, or a failed request.
 */
export function SendButton(props: {
  label: string;
  month: string;
  onSend: (input: { month: string }) => Promise<
    { ok: true; warning?: string } | { ok: false; fieldErrors: Record<string, string> } | null
  >;
}): React.ReactElement {
  return (
    <button type="button" onClick={() => void props.onSend({ month: props.month })}>
      {props.label}
    </button>
  );
}
