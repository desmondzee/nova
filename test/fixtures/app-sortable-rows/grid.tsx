import * as React from "react";

/**
 * A table whose column prop is spelled `cols`, not `columns`. An entirely ordinary
 * catalog choice, and the one that made the spec-text sortable check inert.
 */
export function Grid(props: {
  feed: ReadonlyArray<{ date: string; km: number }>;
  cols: string[];
  sortable: string[];
  sort: { column: string; direction: "asc" | "desc" } | null;
  onSort: (column: string) => void;
}): React.ReactElement {
  return (
    <table data-cols={props.cols.join(",")} data-sortable={props.sortable.join(",")}>
      <tbody>
        <tr>
          <td onClick={() => props.onSort(props.cols[0] ?? "")}>
            {props.feed.length}
            {props.sort === null ? "" : props.sort.column}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
