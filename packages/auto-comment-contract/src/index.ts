export const AUTO_COMMENT_MODES = ["APPROVAL_REQUIRED", "AUTO_SEND"] as const;
export type AutoCommentMode = (typeof AUTO_COMMENT_MODES)[number];

export const REVIEW_DECISIONS = ["TEPAT", "OOT"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const COMMENT_CANDIDATE_STATUSES = [
  "PENDING_REVIEW",
  "COMMENT_QUEUED",
  "OOT",
  "COMMENT_SENT",
  "COMMENT_FAILED",
  "SIDE_EFFECT_UNCERTAIN",
] as const;
export type CommentCandidateStatus = (typeof COMMENT_CANDIDATE_STATUSES)[number];

export type DivisionConfig = Readonly<{
  divisionId: string;
  accountId: string;
  name: string;
  mode: AutoCommentMode;
  keywords: readonly string[];
  templates: readonly string[];
}>;

export type DivisionConfigInput = Omit<DivisionConfig, "mode"> & { mode?: AutoCommentMode };

export type CommentTemplateSnapshot = Readonly<{ templateId: string; text: string }>;

export type CommentCandidateInput = Readonly<{
  candidateId: string;
  division: DivisionConfigInput;
  channelId: string;
  channelPostId: string;
  discussionTargetId: string;
  matchedKeywords: readonly string[];
  template: CommentTemplateSnapshot;
}>;

export type CommentCandidate = Readonly<{
  candidateId: string;
  divisionId: string;
  accountId: string;
  mode: AutoCommentMode;
  channelId: string;
  channelPostId: string;
  discussionTargetId: string;
  matchedKeywords: readonly string[];
  template: CommentTemplateSnapshot;
  status: CommentCandidateStatus;
  decision: ReviewDecision | null;
  idempotencyKey: string;
}>;

export type CommentOutboxCommand = Readonly<{
  kind: "COMMENT_TEXT";
  commandId: string;
  idempotencyKey: string;
  candidateId: string;
  accountId: string;
  channelId: string;
  channelPostId: string;
  discussionTargetId: string;
  text: string;
}>;

export type CandidateCreation =
  | Readonly<{ status: "PENDING_REVIEW"; candidate: CommentCandidate; command: null }>
  | Readonly<{ status: "COMMENT_QUEUED"; candidate: CommentCandidate; command: CommentOutboxCommand }>;

export type CandidateDecisionResult =
  | Readonly<{ status: "COMMENT_QUEUED"; candidate: CommentCandidate; command: CommentOutboxCommand }>
  | Readonly<{ status: "OOT"; candidate: CommentCandidate; command: null }>
  | Readonly<{ status: "ALREADY_DECIDED" | "NOT_AWAITING_REVIEW"; candidate: CommentCandidate; command: null }>;

export type DivisionValidationIssue = Readonly<{ field: string; code: string }>;

export class DivisionValidationError extends Error {
  readonly issues: readonly DivisionValidationIssue[];

  constructor(issues: readonly DivisionValidationIssue[]) {
    super("Konfigurasi Divisi tidak valid.");
    this.name = "DivisionValidationError";
    this.issues = issues;
  }
}

const MAX_NAME_LENGTH = 80;
const MAX_KEYWORD_LENGTH = 256;
const MAX_TEMPLATE_LENGTH = 4096;
const modeSet = new Set<string>(AUTO_COMMENT_MODES);

function required(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeList(value: unknown, field: string, maxLength: number, issues: DivisionValidationIssue[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ field, code: "REQUIRED" });
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!required(entry)) {
      issues.push({ field, code: "REQUIRED" });
      continue;
    }
    const normalized = entry.trim();
    if (normalized.length > maxLength) {
      issues.push({ field, code: "TOO_LONG" });
      continue;
    }
    const duplicateKey = normalized.toLocaleLowerCase("id-ID");
    if (seen.has(duplicateKey)) {
      issues.push({ field, code: "DUPLICATE" });
      continue;
    }
    seen.add(duplicateKey);
    result.push(normalized);
  }
  return result;
}

function freezeConfig(config: DivisionConfig): DivisionConfig {
  return Object.freeze({
    ...config,
    keywords: Object.freeze([...config.keywords]),
    templates: Object.freeze([...config.templates]),
  });
}

export function validateDivisionConfig(input: unknown): DivisionConfig {
  const value = (input ?? {}) as Record<string, unknown>;
  const issues: DivisionValidationIssue[] = [];

  for (const field of ["divisionId", "accountId"]) {
    if (!required(value[field])) issues.push({ field, code: "REQUIRED" });
  }
  if (!required(value.name)) issues.push({ field: "name", code: "REQUIRED" });
  else if (value.name.trim().length > MAX_NAME_LENGTH) issues.push({ field: "name", code: "TOO_LONG" });

  const mode = value.mode ?? "APPROVAL_REQUIRED";
  if (typeof mode !== "string" || !modeSet.has(mode)) issues.push({ field: "mode", code: "UNSUPPORTED" });
  const keywords = normalizeList(value.keywords, "keywords", MAX_KEYWORD_LENGTH, issues);
  const templates = normalizeList(value.templates, "templates", MAX_TEMPLATE_LENGTH, issues);

  if (issues.length > 0) throw new DivisionValidationError(issues);
  return freezeConfig({
    divisionId: (value.divisionId as string).trim(),
    accountId: (value.accountId as string).trim(),
    name: (value.name as string).trim(),
    mode: mode as AutoCommentMode,
    keywords,
    templates,
  });
}

function freezeCandidate(candidate: CommentCandidate): CommentCandidate {
  return Object.freeze({
    ...candidate,
    matchedKeywords: Object.freeze([...candidate.matchedKeywords]),
    template: Object.freeze({ ...candidate.template }),
  });
}

function commandFor(candidate: CommentCandidate): CommentOutboxCommand {
  return Object.freeze({
    kind: "COMMENT_TEXT",
    commandId: "comment:" + candidate.candidateId,
    idempotencyKey: candidate.idempotencyKey,
    candidateId: candidate.candidateId,
    accountId: candidate.accountId,
    channelId: candidate.channelId,
    channelPostId: candidate.channelPostId,
    discussionTargetId: candidate.discussionTargetId,
    text: candidate.template.text,
  });
}

function validCandidateInput(input: CommentCandidateInput): boolean {
  return required(input?.candidateId)
    && required(input?.channelId)
    && required(input?.channelPostId)
    && required(input?.discussionTargetId)
    && Array.isArray(input?.matchedKeywords)
    && input.matchedKeywords.length > 0
    && input.matchedKeywords.every(required)
    && required(input?.template?.templateId)
    && required(input?.template?.text)
    && input.template.text.length <= MAX_TEMPLATE_LENGTH;
}

/** Creates a frozen per-post snapshot. It never evaluates keywords or chooses a template. */
export function createAutoCommentCandidate(input: CommentCandidateInput): CandidateCreation {
  if (!validCandidateInput(input)) throw new TypeError("Kandidat Auto Komen Menfess tidak valid.");
  const division = validateDivisionConfig(input.division);
  const templateText = input.template.text.trim();
  if (!division.templates.includes(templateText)) throw new TypeError("Template kandidat tidak berasal dari Divisi.");
  const divisionKeywords = new Set(division.keywords.map((keyword) => keyword.toLocaleLowerCase("id-ID")));
  if (!input.matchedKeywords.every((keyword) => divisionKeywords.has(keyword.trim().toLocaleLowerCase("id-ID")))) {
    throw new TypeError("Keyword kandidat tidak berasal dari Divisi.");
  }
  const idempotencyKey = "comment:" + division.divisionId + ":" + division.accountId + ":" + input.channelId.trim() + ":" + input.channelPostId.trim();
  const candidate = freezeCandidate({
    candidateId: input.candidateId.trim(),
    divisionId: division.divisionId,
    accountId: division.accountId,
    mode: division.mode,
    channelId: input.channelId.trim(),
    channelPostId: input.channelPostId.trim(),
    discussionTargetId: input.discussionTargetId.trim(),
    matchedKeywords: input.matchedKeywords.map((keyword) => keyword.trim()),
    template: { templateId: input.template.templateId.trim(), text: templateText },
    status: division.mode === "AUTO_SEND" ? "COMMENT_QUEUED" : "PENDING_REVIEW",
    decision: null,
    idempotencyKey,
  });
  if (candidate.mode === "APPROVAL_REQUIRED") return Object.freeze({ status: "PENDING_REVIEW", candidate, command: null });
  return Object.freeze({ status: "COMMENT_QUEUED", candidate, command: commandFor(candidate) });
}

/** Database code must apply the returned candidate and command in one transaction. */
export function decideAutoCommentCandidate(candidate: CommentCandidate, decision: ReviewDecision): CandidateDecisionResult {
  if (!REVIEW_DECISIONS.includes(decision)) throw new TypeError("Keputusan review tidak didukung.");
  if (candidate.status !== "PENDING_REVIEW") {
    const status = candidate.decision === null ? "NOT_AWAITING_REVIEW" : "ALREADY_DECIDED";
    return Object.freeze({ status, candidate, command: null });
  }
  if (decision === "OOT") {
    const skipped = freezeCandidate({ ...candidate, status: "OOT", decision: "OOT" });
    return Object.freeze({ status: "OOT", candidate: skipped, command: null });
  }
  const approved = freezeCandidate({ ...candidate, status: "COMMENT_QUEUED", decision: "TEPAT" });
  return Object.freeze({ status: "COMMENT_QUEUED", candidate: approved, command: commandFor(approved) });
}
