import * as React from "react";

export function Table(props: {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  empty?: string;
}): React.ReactElement {
  return <table data-columns={props.columns.join(",")}>{props.rows.length}</table>;
}

/**
 * A table whose column names are strings as far as its own type is concerned — the
 * ordinary catalog shape, and the one that let `columns: [dayz]` render a column of en
 * dashes. What the names have to be keys of is the row type, which only nova knows.
 */
export function Breakdown(props: {
  rows: ReadonlyArray<Record<string, unknown>>;
  columns: string[];
  numeric?: string[];
}): React.ReactElement {
  return (
    <table data-columns={props.columns.join(",")} data-numeric={(props.numeric ?? []).join(",")}>
      {props.rows.length}
    </table>
  );
}

export function StatCard(props: { label: string; value: string }): React.ReactElement {
  return <div>{props.label}: {props.value}</div>;
}

export function Loading(props: { label?: string }): React.ReactElement {
  return <p>{props.label ?? "Loading"}</p>;
}

export function ErrorNotice(props: { children: React.ReactNode }): React.ReactElement {
  return <p role="alert">{props.children}</p>;
}

export function EmptyState(props: { title: string }): React.ReactElement {
  return <p>{props.title}</p>;
}

export const MONTHS = ["Jan", "Feb"];

export function formatKm(n: number): string {
  return `${n} km`;
}

/**
 * The page shell: nova wraps every page's sections in it and hands it the page's
 * `title:`. `title` is optional because a page need not declare one.
 */
export function PageShell(props: {
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <main>
      {props.title === undefined ? null : <h1>{props.title}</h1>}
      <div className="stack">{props.children}</div>
    </main>
  );
}
