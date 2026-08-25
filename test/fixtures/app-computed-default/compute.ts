// A filter default that is a value rather than a literal. Time handling stays in the
// app's own code — nova calls this and never knows what a month is.
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
