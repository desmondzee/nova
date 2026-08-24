export type Trip = { date: string; km: number };

export async function trips(input: { month: string }): Promise<Trip[]> {
  return [{ date: `${input.month}-01`, km: 12 }];
}

export async function monthlyTotal(input: { month: string }): Promise<string> {
  return `${input.month}: 12 km`;
}
