// A loader with no parameters — a normal pattern (e.g. a loader that always
// returns the same query, or reads no input at all).
export async function status(): Promise<string> {
  return "ok";
}
