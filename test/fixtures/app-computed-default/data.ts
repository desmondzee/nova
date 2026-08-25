export async function trips(input: { month: string }): Promise<Array<{ date: string; km: number }>> {
  return [{ date: `${input.month}-01`, km: 12 }];
}
