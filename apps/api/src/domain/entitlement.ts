export type EntitlementGrantInput = Readonly<{
  packageId: string;
  durationDays: number;
  maxLpmGroups: number;
  maxChannelTargets: number;
}>;

export class EntitlementValidationError extends Error {
  readonly issues: readonly { field: string; code: string }[];
  constructor(issues: readonly { field: string; code: string }[]) {
    super("Entitlement tidak valid.");
    this.issues = issues;
  }
}

export function validateEntitlementGrant(input: unknown): EntitlementGrantInput {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const issues: { field: string; code: string }[] = [];
  const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (!uuid(value.packageId)) issues.push({ field: "packageId", code: "INVALID_UUID" });
  for (const field of ["durationDays", "maxLpmGroups", "maxChannelTargets"]) {
    const v = value[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || (field === "durationDays" && v === 0)) issues.push({ field, code: field === "durationDays" ? "MUST_BE_POSITIVE_INTEGER" : "MUST_BE_NON_NEGATIVE_INTEGER" });
  }
  if (issues.length) throw new EntitlementValidationError(issues);
  return Object.freeze({ packageId: value.packageId as string, durationDays: value.durationDays as number, maxLpmGroups: value.maxLpmGroups as number, maxChannelTargets: value.maxChannelTargets as number });
}
