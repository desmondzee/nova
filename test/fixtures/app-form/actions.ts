// Declared as an `interface` on purpose. An interface gets no implicit index signature,
// so it is NOT assignable to `Record<string, unknown>` — a `useForm<T extends
// Record<string, unknown>>` constraint would reject this entirely ordinary action.
export interface TripInput {
  date: string;
  km: number;
  purpose: string;
}

export async function saveTrip(
  input: TripInput,
): Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> {
  return input.km > 0 ? { ok: true } : { ok: false, fieldErrors: { km: "must be positive" } };
}
