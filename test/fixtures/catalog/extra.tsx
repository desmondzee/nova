import * as React from "react";

export function Table(props: {
  rows: Array<Record<string, unknown>>;
  columns: string[];
}): React.ReactElement {
  return <table data-source="extra">{props.rows.length}</table>;
}

export function Banner(props: { message: string }): React.ReactElement {
  return <div role="banner">{props.message}</div>;
}
