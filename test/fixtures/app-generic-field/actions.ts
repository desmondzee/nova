export interface PolicyInput {
  basis: string;
  notes: string;
}

export async function savePolicy(
  input: PolicyInput,
): Promise<{ ok: true } | { ok: false; fieldErrors: Record<string, string> }> {
  return input.basis === "" ? { ok: false, fieldErrors: { basis: "required" } } : { ok: true };
}
