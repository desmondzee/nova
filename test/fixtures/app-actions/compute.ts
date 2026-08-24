// Pure, no HTTP, bundled into the client (§6.4). Referenced by a `compute#` binding,
// which reaches the component as the function itself rather than a called result.
export function formatKm(n: number): string {
  return `${n} km`;
}
