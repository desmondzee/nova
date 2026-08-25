// Two mutations with deliberately different input keys. A per-row action reaches the
// component as a plain prop rather than through a form, and the row the component hands
// it has to be something the action actually accepts.
export async function deleteTrip(input: { id: string }): Promise<{ ok: true }> {
  return input.id === "" ? { ok: true } : { ok: true };
}

export async function archiveTrip(input: { tripId: string }): Promise<{ ok: true }> {
  return input.tripId === "" ? { ok: true } : { ok: true };
}
