import * as React from "react";

/** A read-only component whose own prop is called `fields`. */
export function Roster(props: { fields: string[] }): React.ReactElement {
  return <ul>{props.fields.join(",")}</ul>;
}
