export async function rows(input: { month: string }): Promise<Array<Record<string, unknown>>> {
  return [{ name: input.month }];
}

export async function distance(input: { month: string }): Promise<number> {
  return input.month.length;
}
