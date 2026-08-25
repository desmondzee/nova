// A detail page: one loader, five sections, four of which read a different part of its
// answer. The shape both remaining defects live in — one failure used to read four times
// over, and the day table's `columns:`/`numeric:` name keys of a row type nested one
// property inside the loader's result, which no check had ever reached.
export type Day = { day: string; hours: number };

export async function travel(input: { id: string }): Promise<{
  total: string;
  place: string;
  note: string;
  days: Day[];
}> {
  return { total: `#${input.id}`, place: "Hanover", note: "", days: [] };
}
