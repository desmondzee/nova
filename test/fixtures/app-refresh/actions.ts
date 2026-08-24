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
