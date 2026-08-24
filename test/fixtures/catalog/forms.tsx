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

export function ActionButton(props: {
  label: string;
  onSubmit: (input: unknown) => Promise<boolean>;
}): React.ReactElement {
  return (
    <button type="button" onClick={() => void props.onSubmit({})}>
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
