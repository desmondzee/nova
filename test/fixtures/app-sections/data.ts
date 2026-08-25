// Three independent loaders on one page: one feeds a stat, one a nested table, one a
// sidecar. A page like this is the shape the equivalence audit fault-injected — a
// single failure must not take the other two, or the loader-free heading, with it.
export type Trip = { date: string; km: number };

export async function trips(input: { month: string }): Promise<Array<Record<string, unknown>>> {
  return [{ date: `${input.month}-01`, km: 12 }];
}

export async function monthlyTotal(input: { month: string }): Promise<string> {
  return `${input.month}: 12 km`;
}

export async function policy(input: { month: string }): Promise<string> {
  return `policy for ${input.month}`;
}
