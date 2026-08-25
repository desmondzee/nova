// A paginated table: the browser holds one page of rows, so ordering them there would
// sort 25 of 6,480. The loader says so by declaring `sort` and `dir` in its own input.
export async function deals(input: {
  page: string;
  sort: string;
  dir: "asc" | "desc";
}): Promise<Array<Record<string, unknown>>> {
  return [{ id: input.page, value: `${input.sort}:${input.dir}` }];
}
