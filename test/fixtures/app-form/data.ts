// A loader read by a *field's* own prop rather than by a section's. Field props bind
// like any other, so every walker that discovers loaders, filters and route params has
// to descend into `fields:` as well as into `children:`.
export async function purposes(input: { month: string }): Promise<string[]> {
  return [`business ${input.month}`, "private"];
}
