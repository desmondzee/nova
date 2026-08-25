// One loader declaring a single filter, and one declaring no input at all — the shape a
// reporting page has several of (constant option lists beside a scoped table).
export async function monthlyTotal(input: { month: string }): Promise<string> {
  return `${input.month}: 12 km`;
}

export async function regions(): Promise<Array<Record<string, unknown>>> {
  return [{ name: "north" }];
}
