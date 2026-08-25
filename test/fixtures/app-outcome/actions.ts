// An action with three outcomes, not two: the upstream accepted it, the upstream accepted
// it and said something about it, or it was rejected per field. A component handed this
// action has to be able to tell the middle one from the last.
export type SubmitResult =
  | { ok: true; warning?: string }
  | { ok: false; fieldErrors: Record<string, string> };

export async function submitMonth(input: { month: string }): Promise<SubmitResult> {
  return input.month === "" ? { ok: false, fieldErrors: { month: "required" } } : { ok: true };
}
