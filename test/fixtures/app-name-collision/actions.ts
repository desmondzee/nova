// Same name as the loader in data.ts. Emitting both produces `export type Sync` twice
// in types.ts and `const _sync` twice in __contract.ts.
export async function sync(input: { km: number }): Promise<{ ok: true }> {
  return input.km > 0 ? { ok: true } : { ok: true };
}
