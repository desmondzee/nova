// Deliberately non-async: __contract.ts's `(input: TripsInput) => Promise<Trips>`
// binding catches this even though the JSX/props seam (pages.tsx) does not, since
// `Trips` is itself derived from this same return type.
export function trips(input: { month: string }): Array<{ date: string }> {
  return [{ date: `${input.month}-01` }];
}
