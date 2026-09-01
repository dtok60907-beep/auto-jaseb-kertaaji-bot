import type { AutoCommentMode } from "../../../../packages/auto-comment-contract/src/index.ts";
import type {
  ChannelTargetInput,
  DivisionPatch,
  DivisionSettingInput,
  TemplateSettingInput,
} from "../domain/auto-comment-settings.ts";

export type SafeUserbotAccountView = Readonly<{
  id: string;
  label: string;
  status: "DISCONNECTED" | "READY" | "DEGRADED" | "REVOKED" | "DISABLED";
}>;

export type AutoCommentDivisionView = Readonly<{
  id: string;
  accountId: string;
  name: string;
  mode: AutoCommentMode;
  active: boolean;
  keywords: readonly Readonly<{ id: string; keyword: string }>[];
  templates: readonly Readonly<{
    id: string;
    text: string;
    displayOrder: number;
    active: boolean;
  }>[];
  channelTargetIds: readonly string[];
}>;

export type AutoCommentChannelTargetView = Readonly<{
  id: string;
  accountId: string;
  sourceChannelRef: string;
  discussionTargetRef: string | null;
  resolutionStatus: "QUEUED" | "CHECKING" | "JOINING" | "WAITING_APPROVAL" | "READY" | "NEEDS_REVALIDATION" | "FAILED_FINAL";
  lastErrorCode: string | null;
  active: boolean;
  divisionIds: readonly string[];
}>;

export type AutoCommentSettingsView = Readonly<{
  accounts: readonly SafeUserbotAccountView[];
  divisions: readonly AutoCommentDivisionView[];
  channelTargets: readonly AutoCommentChannelTargetView[];
}>;

export type AutoCommentDecision = "TEPAT" | "OOT";
export type AutoCommentDecisionResult = Readonly<{
  status: "COMMENT_QUEUED" | "OOT" | "ALREADY_DECIDED" | "NOT_AWAITING_REVIEW" | "NOT_FOUND";
  candidateId: string;
  operationId: string | null;
  commandId: string | null;
}>;

export interface AutoCommentSettingsRepository {
  listSettings(userId: string): Promise<AutoCommentSettingsView>;
  createDivision(input: Readonly<{ userId: string; division: DivisionSettingInput }>): Promise<AutoCommentDivisionView>;
  updateDivision(input: Readonly<{ userId: string; id: string; patch: DivisionPatch }>): Promise<AutoCommentDivisionView | null>;
  deleteDivision(input: Readonly<{ userId: string; id: string }>): Promise<boolean>;
  createKeyword(input: Readonly<{ userId: string; divisionId: string; keyword: string }>): Promise<Readonly<{ id: string; keyword: string }> | null>;
  deleteKeyword(input: Readonly<{ userId: string; divisionId: string; id: string }>): Promise<boolean>;
  createTemplate(input: Readonly<{ userId: string; divisionId: string; template: TemplateSettingInput }>): Promise<AutoCommentDivisionView["templates"][number] | null>;
  updateTemplate(input: Readonly<{ userId: string; divisionId: string; id: string; template: TemplateSettingInput }>): Promise<AutoCommentDivisionView["templates"][number] | null>;
  deleteTemplate(input: Readonly<{ userId: string; divisionId: string; id: string }>): Promise<boolean>;
  createChannelTarget(input: Readonly<{ userId: string; target: ChannelTargetInput }>): Promise<AutoCommentChannelTargetView>;
  updateChannelTarget(input: Readonly<{ userId: string; id: string; patch: Readonly<{ sourceChannelRef: string; active: boolean }> }>): Promise<AutoCommentChannelTargetView | null>;
  deleteChannelTarget(input: Readonly<{ userId: string; id: string }>): Promise<boolean>;
  attachChannel(input: Readonly<{ userId: string; divisionId: string; channelTargetId: string }>): Promise<"ATTACHED" | "NOT_FOUND">;
  detachChannel(input: Readonly<{ userId: string; divisionId: string; channelTargetId: string }>): Promise<boolean>;
  decideCandidate(input: Readonly<{ userId: string; candidateId: string; decision: AutoCommentDecision }>): Promise<AutoCommentDecisionResult>;
  /** Resolves a Telegram user id (from a bot update) to their app_users id, or null if they have never authenticated through the Mini App. */
  resolveOwnerId(telegramUserId: string): Promise<string | null>;
}
