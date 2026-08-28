export const ACCOUNT_MODES = ["JASEB_WORKER", "USERBOT"] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export type BroadcastRequest = {
  operationId: string;
  accountId: string;
  accountMode: AccountMode;
  targetIds: readonly string[];
  text: string;
};

export type SendCommand = {
  kind: "SEND_TEXT";
  commandId: string;
  idempotencyKey: string;
  operationId: string;
  accountId: string;
  accountMode: AccountMode;
  targetId: string;
  text: string;
};

export type BroadcastPlan =
  | { status: "PLANNED"; commands: readonly SendCommand[] }
  | { status: "REJECTED"; code: "INVALID_BROADCAST" | "DUPLICATE_TARGET"; commands: readonly [] };

const MAX_TEXT_LENGTH = 4096;

function required(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function planBroadcast(request: BroadcastRequest): BroadcastPlan {
  if (!required(request?.operationId) || !required(request?.accountId) || !ACCOUNT_MODES.includes(request?.accountMode) || !required(request?.text) || request.text.length > MAX_TEXT_LENGTH || !Array.isArray(request?.targetIds) || request.targetIds.length === 0 || request.targetIds.some((target) => !required(target))) {
    return { status: "REJECTED", code: "INVALID_BROADCAST", commands: [] };
  }
  const targets = request.targetIds.map((target) => target.trim());
  if (new Set(targets).size !== targets.length) return { status: "REJECTED", code: "DUPLICATE_TARGET", commands: [] };
  const commands = targets.map((targetId) => ({
    kind: "SEND_TEXT" as const,
    commandId: `send:${request.operationId}:${targetId}`,
    idempotencyKey: `broadcast:${request.operationId}:${targetId}`,
    operationId: request.operationId,
    accountId: request.accountId.trim(),
    accountMode: request.accountMode,
    targetId,
    text: request.text,
  }));
  return { status: "PLANNED", commands };
}
