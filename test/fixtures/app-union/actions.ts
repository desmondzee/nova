// `vehicle` is a union, which is the whole point of this fixture: the type safety a
// spec compiler exists to provide is exactly what widening it to `string` would lose.
export interface TripInput {
  purpose: string;
  vehicle: "car" | "van";
}

export async function saveTrip(
  input: TripInput,
): Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> {
  return input.purpose === "" ? { ok: false, fieldErrors: { purpose: "required" } } : { ok: true };
}
