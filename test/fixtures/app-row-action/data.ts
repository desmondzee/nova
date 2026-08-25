export type Trip = { id: string; date: string; km: number };

export async function trips(): Promise<Trip[]> {
  return [];
}
