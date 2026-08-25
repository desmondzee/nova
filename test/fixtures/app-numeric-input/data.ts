// A loader whose declared input is a lie: the generated handler calls it with
// `Object.fromEntries(searchParams)`, so `limit` arrives as the string "25" however the
// signature spells it. `dir` is fine — a string can be "asc" — and is here to pin that
// the check narrows to types a string can never be rather than to "not exactly string".
export async function deals(input: {
  limit: number;
  dir: "asc" | "desc";
  month: string;
}): Promise<Array<Record<string, unknown>>> {
  return [{ id: `${input.limit}`, value: `${input.month}:${input.dir}` }];
}
