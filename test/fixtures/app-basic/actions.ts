export async function saveTrip(
  input: { date: string; km: number },
): Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> {
  return input.km > 0 ? { ok: true } : { ok: false, fieldErrors: { km: "must be positive" } };
}
