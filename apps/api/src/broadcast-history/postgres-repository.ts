import type { Sql } from "postgres";

import type { BroadcastHistoryEntry, BroadcastHistoryPage, BroadcastHistoryRepository } from "./repository.ts";

const PUBLIC_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export function bubbleLinkFor(telegramTargetRef: string, providerMessageIds: readonly string[]): string | null {
  const messageId = providerMessageIds[0];
  if (!messageId) return null;
  const stripped = telegramTargetRef.trim().replace(/^https?:\/\/(www\.)?t\.me\//i, "").replace(/^@/, "");
  if (!PUBLIC_USERNAME.test(stripped)) return null;
  return `https://t.me/${stripped}/${messageId}`;
}

type Row = {
  id: string;
  account_id: string;
  account_label: string;
  telegram_target_ref: string;
  resolved_title: string | null;
  last_success_at: string;
  last_provider_message_ids: string[];
};

function parseCursor(cursor: string | null): Readonly<{ sentAt: string; id: string }> | null {
  if (cursor === null) return null;
  const separatorIndex = cursor.lastIndexOf("_");
  if (separatorIndex <= 0) return null;
  const sentAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 1);
  if (Number.isNaN(Date.parse(sentAt)) || !id) return null;
  return Object.freeze({ sentAt, id });
}

export class PostgresBroadcastHistoryRepository implements BroadcastHistoryRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async list(input: Parameters<BroadcastHistoryRepository["list"]>[0]): Promise<BroadcastHistoryPage> {
    const cursor = parseCursor(input.before);
    const rows = await this.sql<Row[]>`
      select target.id::text, operation.account_id::text, account.label as account_label,
             target.telegram_target_ref, target.resolved_title,
             target.last_success_at::text, target.last_provider_message_ids
        from public.broadcast_targets target
        join public.workflow_operations operation on operation.id = target.operation_id
        join public.telegram_accounts account on account.id = operation.account_id
       where operation.user_id = ${input.userId}::uuid
         and operation.operation_type = 'BROADCAST'
         and target.delivery_status = 'SUCCEEDED'
         and target.last_success_at is not null
         and (
           ${cursor === null} or
           (target.last_success_at, target.id) < (${cursor?.sentAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
         )
       order by target.last_success_at desc, target.id desc
       limit ${input.limit}
    `;
    const entries = rows.map((row): BroadcastHistoryEntry => Object.freeze({
      id: row.id,
      accountId: row.account_id,
      accountLabel: row.account_label,
      telegramTargetRef: row.telegram_target_ref,
      resolvedTitle: row.resolved_title,
      sentAt: new Date(row.last_success_at).toISOString(),
      bubbleLink: bubbleLinkFor(row.telegram_target_ref, row.last_provider_message_ids ?? []),
    }));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === input.limit && last ? `${last.last_success_at}_${last.id}` : null;
    return Object.freeze({ entries: Object.freeze(entries), nextCursor });
  }
}
