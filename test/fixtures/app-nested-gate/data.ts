// A page whose first binder of `trips` sits *inside* a section gated by a different
// loader. If `heading` fails the Panel renders its notice and its children are never
// rendered at all — so whatever the Table would have said about `trips` is said nowhere,
// and `Breakdown`, later in document order, must not assume it was already said.
export async function heading(): Promise<string> {
  return "Activity";
}

export async function trips(): Promise<Array<Record<string, unknown>>> {
  return [{ date: "2026-08-01", km: 12 }];
}
