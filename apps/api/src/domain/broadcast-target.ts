export type BroadcastLpmTarget = Readonly<{
  telegramTargetRef: string;
  label: string | null;
  active: boolean;
}>;

export type BroadcastTargetValidationIssue = Readonly<{ field: string; code: string }>;

export class BroadcastTargetValidationError extends Error {
  readonly issues: readonly BroadcastTargetValidationIssue[];

  constructor(issues: readonly BroadcastTargetValidationIssue[]) {
    super("Target Grup LPM tidak valid.");
    this.name = "BroadcastTargetValidationError";
    this.issues = issues;
  }
}

function required(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateBroadcastLpmTarget(input: unknown): BroadcastLpmTarget {
  const value = (input ?? {}) as Record<string, unknown>;
  const issues: BroadcastTargetValidationIssue[] = [];

  if (!required(value.telegramTargetRef)) issues.push({ field: "telegramTargetRef", code: "REQUIRED" });
  else if (value.telegramTargetRef.trim().length > 256) issues.push({ field: "telegramTargetRef", code: "TOO_LONG" });

  if (value.label !== undefined && value.label !== null) {
    if (!required(value.label)) issues.push({ field: "label", code: "REQUIRED" });
    else if (value.label.trim().length > 80) issues.push({ field: "label", code: "TOO_LONG" });
  }
  if (typeof value.active !== "boolean") issues.push({ field: "active", code: "MUST_BE_BOOLEAN" });

  if (issues.length > 0) throw new BroadcastTargetValidationError(issues);
  return Object.freeze({
    telegramTargetRef: (value.telegramTargetRef as string).trim(),
    label: typeof value.label === "string" ? value.label.trim() : null,
    active: value.active as boolean,
  });
}
