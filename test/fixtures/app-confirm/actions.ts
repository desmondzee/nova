// A destructive mutation — the 39 hand-rolled `window.confirm` calls in the target
// codebase guard exactly this shape.
export async function deleteTrip(input: { id: string }): Promise<{ ok: true }> {
  return input.id === "" ? { ok: true } : { ok: true };
}
