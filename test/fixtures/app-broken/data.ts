/** Deliberately the wrong shape: Table wants an array of records, this is a number. */
export async function trips(input: { month: string }): Promise<number> {
  return input.month.length;
}
