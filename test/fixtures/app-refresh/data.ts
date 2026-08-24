export type Trip = { date: string; km: number };

// No parameters: this page declares no filters, so the list is the whole list — which
// is also what makes "the row I just saved is missing" the obvious failure.
export async function trips(): Promise<Trip[]> {
  return [];
}
