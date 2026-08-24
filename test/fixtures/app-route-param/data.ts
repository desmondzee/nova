// The loader's declared input is satisfied entirely by the route's own ':id' parameter —
// this page declares no filters at all, so nothing but params can supply it.
export async function trip(input: { id: string }): Promise<{ id: string; km: number }> {
  return { id: input.id, km: 12 };
}
