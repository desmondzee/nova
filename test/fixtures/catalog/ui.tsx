import * as React from "react";

export function Table(props: {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  empty?: string;
}): React.ReactElement {
  return <table data-columns={props.columns.join(",")}>{props.rows.length}</table>;
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
