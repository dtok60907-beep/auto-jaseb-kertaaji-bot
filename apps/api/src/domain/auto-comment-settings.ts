import { AUTO_COMMENT_MODES, type AutoCommentMode } from "./auto-comment-contract.ts";

export type AutoCommentSettingsIssue = Readonly<{ field: string; code: string }>;

export class AutoCommentSettingsValidationError extends Error {
  readonly issues: readonly AutoCommentSettingsIssue[];

  constructor(issues: readonly AutoCommentSettingsIssue[]) {
    super("Konfigurasi Auto Komen tidak valid.");
    this.issues = issues;
  }
}
export type DivisionSettingInput = Readonly<{
  accountId: string;
  name: string;
  mode: AutoCommentMode;
  active: boolean;
}>;

export type DivisionPatch = Readonly<{
  name: string;
  mode: AutoCommentMode;
  active: boolean;
}>;

export type TemplateSettingInput = Readonly<{
  text: string;
  displayOrder: number;
  active: boolean;
}>;

export type ChannelTargetInput = Readonly<{
  accountId: string;
  sourceChannelRef: string;
  active: boolean;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const username = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const modeSet = new Set<string>(AUTO_COMMENT_MODES);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactObject(value: unknown, fields: readonly string[]): { input: Record<string, unknown>; issues: AutoCommentSettingsIssue[] } {
  const input = object(value);
  if (!input) return { input: {}, issues: [{ field: "body", code: "MUST_BE_OBJECT" }] };
  const allowed = new Set(fields);
  return {
    input,
    issues: Object.keys(input).filter((key) => !allowed.has(key)).map((field) => ({ field, code: "UNSUPPORTED" })),
  };
}

function requiredString(value: unknown, field: string, maxLength: number, issues: AutoCommentSettingsIssue[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ field, code: "REQUIRED" });
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    issues.push({ field, code: "TOO_LONG" });
    return null;
  }
  return normalized;
}

function requiredBoolean(value: unknown, field: string, issues: AutoCommentSettingsIssue[]): boolean | null {
  if (typeof value !== "boolean") {
    issues.push({ field, code: "MUST_BE_BOOLEAN" });
    return null;
  }
  return value;
}

function requiredMode(value: unknown, issues: AutoCommentSettingsIssue[]): AutoCommentMode | null {
  if (typeof value !== "string" || !modeSet.has(value)) {
    issues.push({ field: "mode", code: "UNSUPPORTED" });
    return null;
  }
  return value as AutoCommentMode;
}

function requiredUuid(value: unknown, field: string, issues: AutoCommentSettingsIssue[]): string | null {
  if (typeof value !== "string" || !uuid.test(value)) {
    issues.push({ field, code: "INVALID_UUID" });
    return null;
  }
  return value;
}

function fail(issues: AutoCommentSettingsIssue[]): never {
  throw new AutoCommentSettingsValidationError(Object.freeze(issues));
}

export function validateDivisionSetting(input: unknown): DivisionSettingInput {
  const { input: value, issues } = exactObject(input, ["accountId", "name", "mode", "active"]);
  const accountId = requiredUuid(value.accountId, "accountId", issues);
  const name = requiredString(value.name, "name", 80, issues);
  const mode = requiredMode(value.mode ?? "APPROVAL_REQUIRED", issues);
  const active = requiredBoolean(value.active ?? true, "active", issues);
  if (issues.length > 0 || !accountId || !name || !mode || active === null) fail(issues);
  return Object.freeze({ accountId, name, mode, active });
}

export function validateDivisionPatch(input: unknown): DivisionPatch {
  const { input: value, issues } = exactObject(input, ["name", "mode", "active"]);
  const name = requiredString(value.name, "name", 80, issues);
  const mode = requiredMode(value.mode, issues);
  const active = requiredBoolean(value.active, "active", issues);
  if (issues.length > 0 || !name || !mode || active === null) fail(issues);
  return Object.freeze({ name, mode, active });
}

export function validateKeyword(input: unknown): string {
  const { input: value, issues } = exactObject(input, ["keyword"]);
  const keyword = requiredString(value.keyword, "keyword", 256, issues);
  if (issues.length > 0 || !keyword) fail(issues);
  return keyword;
}

export function validateTemplateSetting(input: unknown): TemplateSettingInput {
  const { input: value, issues } = exactObject(input, ["text", "displayOrder", "active"]);
  const text = requiredString(value.text, "text", 4096, issues);
  const displayOrder = value.displayOrder ?? 0;
  if (!Number.isInteger(displayOrder) || typeof displayOrder !== "number" || displayOrder < 0) {
    issues.push({ field: "displayOrder", code: "MUST_BE_NON_NEGATIVE_INTEGER" });
  }
  const active = requiredBoolean(value.active ?? true, "active", issues);
  if (issues.length > 0 || !text || typeof displayOrder !== "number" || !Number.isInteger(displayOrder) || displayOrder < 0 || active === null) fail(issues);
  return Object.freeze({ text, displayOrder, active });
}

function normalizeChannelRef(value: string): string | null {
  const usernameValue = value.startsWith("@") ? value.slice(1) : value;
  const link = /^https?:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i.exec(value);
  const normalized = link?.[1] ?? usernameValue;
  return username.test(normalized) ? "@" + normalized : null;
}

export function validateChannelTarget(input: unknown): ChannelTargetInput {
  const { input: value, issues } = exactObject(input, ["accountId", "sourceChannelRef", "active"]);
  const accountId = requiredUuid(value.accountId, "accountId", issues);
  let sourceChannelRef: string | null = null;
  if (typeof value.sourceChannelRef === "string") sourceChannelRef = normalizeChannelRef(value.sourceChannelRef.trim());
  if (!sourceChannelRef) issues.push({ field: "sourceChannelRef", code: "PUBLIC_CHANNEL_REQUIRED" });
  const active = requiredBoolean(value.active ?? true, "active", issues);
  if (issues.length > 0 || !accountId || !sourceChannelRef || active === null) fail(issues);
  return Object.freeze({ accountId, sourceChannelRef, active });
}

export function validateChannelTargetPatch(input: unknown): Readonly<{ sourceChannelRef: string; active: boolean }> {
  const { input: value, issues } = exactObject(input, ["sourceChannelRef", "active"]);
  let sourceChannelRef: string | null = null;
  if (typeof value.sourceChannelRef === "string") sourceChannelRef = normalizeChannelRef(value.sourceChannelRef.trim());
  if (!sourceChannelRef) issues.push({ field: "sourceChannelRef", code: "PUBLIC_CHANNEL_REQUIRED" });
  const active = requiredBoolean(value.active, "active", issues);
  if (issues.length > 0 || !sourceChannelRef || active === null) fail(issues);
  return Object.freeze({ sourceChannelRef, active });
}
