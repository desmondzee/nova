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
