// Requires two inputs. The spec's page declares no filters and its route has no
// parameters, so nova can supply neither — which must be a diagnostic at the binding,
// not a confidently-generated call that fails at runtime.
export async function summary(input: { month: string; region: string }): Promise<string> {
  return `${input.month}/${input.region}`;
}
