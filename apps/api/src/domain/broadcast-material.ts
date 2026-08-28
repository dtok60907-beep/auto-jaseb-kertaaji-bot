export const BROADCAST_MATERIAL_KINDS = ["TEXT", "FORWARD"] as const;
export type BroadcastMaterialKind = (typeof BROADCAST_MATERIAL_KINDS)[number];

export const FORWARD_SOURCE_ATTRIBUTIONS = ["SHOW_SOURCE", "HIDE_SOURCE"] as const;
export type ForwardSourceAttribution = (typeof FORWARD_SOURCE_ATTRIBUTIONS)[number];

export type TextBroadcastMaterial = Readonly<{
  kind: "TEXT";
  text: string;
}>;

export type ForwardSource = Readonly<{
  channelUsername: string;
  messageId: number;
  canonicalLink: string;
}>;

export type ForwardBroadcastMaterial = Readonly<{
  kind: "FORWARD";
  source: ForwardSource;
  sourceAttribution: ForwardSourceAttribution;
}>;

export type BroadcastMaterial = TextBroadcastMaterial | ForwardBroadcastMaterial;

export type BroadcastMaterialValidationIssue = Readonly<{ field: string; code: string }>;

export class BroadcastMaterialValidationError extends Error {
  readonly issues: readonly BroadcastMaterialValidationIssue[];

  constructor(issues: readonly BroadcastMaterialValidationIssue[]) {
    super("Materi Jasa Sebar tidak valid.");
    this.name = "BroadcastMaterialValidationError";
    this.issues = issues;
  }
}

const MAX_TEXT_LENGTH = 4096;
const sourceAttributionSet = new Set<string>(FORWARD_SOURCE_ATTRIBUTIONS);
const publicUsername = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

function required(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parsePublicTelegramPostLink(value: unknown): ForwardSource | null {
  if (!required(value)) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || (url.hostname !== "t.me" && url.hostname !== "www.t.me")) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || !publicUsername.test(segments[0] ?? "")) return null;
  const messageId = Number(segments[1]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0 || String(messageId) !== segments[1]) return null;

  const channelUsername = segments[0];
  return Object.freeze({
    channelUsername,
    messageId,
    canonicalLink: "https://t.me/" + channelUsername + "/" + messageId,
  });
}

export function validateBroadcastMaterial(input: unknown): BroadcastMaterial {
  const value = (input ?? {}) as Record<string, unknown>;
  const kind = value.kind;

  if (kind === "TEXT") {
    const issues: BroadcastMaterialValidationIssue[] = [];
    if (!required(value.text)) issues.push({ field: "text", code: "REQUIRED" });
    if (value.sourceLink !== undefined) issues.push({ field: "sourceLink", code: "FORBIDDEN_FOR_TEXT" });
    if (value.sourceAttribution !== undefined) issues.push({ field: "sourceAttribution", code: "FORBIDDEN_FOR_TEXT" });
    if (issues.length > 0) throw new BroadcastMaterialValidationError(issues);
    const text = (value.text as string).trim();
    if (text.length > MAX_TEXT_LENGTH) throw new BroadcastMaterialValidationError([{ field: "text", code: "TOO_LONG" }]);
    return Object.freeze({ kind: "TEXT", text });
  }

  if (kind === "FORWARD") {
    const source = parsePublicTelegramPostLink(value.sourceLink);
    const issues: BroadcastMaterialValidationIssue[] = [];
    if (!source) issues.push({ field: "sourceLink", code: "PUBLIC_POST_LINK_REQUIRED" });
    if (value.text !== undefined) issues.push({ field: "text", code: "FORBIDDEN_FOR_FORWARD" });
    const sourceAttribution = value.sourceAttribution ?? "SHOW_SOURCE";
    if (typeof sourceAttribution !== "string" || !sourceAttributionSet.has(sourceAttribution)) {
      issues.push({ field: "sourceAttribution", code: "UNSUPPORTED" });
    }
    if (issues.length > 0) throw new BroadcastMaterialValidationError(issues);
    return Object.freeze({ kind: "FORWARD", source: source!, sourceAttribution: sourceAttribution as ForwardSourceAttribution });
  }

  throw new BroadcastMaterialValidationError([{ field: "kind", code: "UNSUPPORTED" }]);
}
