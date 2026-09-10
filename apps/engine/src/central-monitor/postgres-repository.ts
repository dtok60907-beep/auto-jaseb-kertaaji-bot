import type { Sql } from "postgres";

import type {
  CentralCandidateResult,
  CentralMonitorDivision,
  CentralMonitorEvent,
  CentralMonitorRepository,
  CentralMonitorSource,
} from "./repository.ts";

export const CENTRAL_MONITOR_WAKEUP_CHANNEL = "jaseb_auto_comment_monitor";

type SourceRow = Readonly<{
  source_id: string;
  source_channel_ref: string;
  provider_peer_id: string | null;
  last_post_id: string | null;
  channel_target_id: string | null;
  account_id: string | null;
  division_id: string | null;
  mode: CentralMonitorDivision["mode"] | null;
  telegram_user_id: string | null;
  discussion_target_ref: string | null;
  central_monitor_start_post_id: string | null;
  central_monitor_activated_at: string | null;
  keywords: string[] | null;
  template_id: string | null;
  template_text: string | null;
}>;
type EventRow = Readonly<{
  event_id: string;
  source_id: string;
  source_channel_ref: string;
  provider_post_id: string;
  content: string;
  provider_posted_at: string | null;
}>;

function event(row: EventRow): CentralMonitorEvent {
  return Object.freeze({
    eventId: row.event_id,
    sourceId: row.source_id,
    sourceChannelRef: row.source_channel_ref,
    providerPostId: Number(row.provider_post_id),
    content: row.content,
    providerPostedAt: row.provider_posted_at,
  });
}

export class PostgresCentralMonitorRepository implements CentralMonitorRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async findActiveAccount() {
    const rows = await this.sql<{ account_id: string }[]>`
      select id::text as account_id
        from public.telegram_accounts
       where account_type = 'MONITOR'
         and monitor_active
         and status = 'READY'
         and encrypted_session is not null
         and (runtime_retry_at is null or runtime_retry_at <= now())
       order by created_at, id
       limit 1
    `;
    return rows[0] ? Object.freeze({ accountId: rows[0].account_id }) : null;
  }

  async loadAccountSession(input: Parameters<CentralMonitorRepository["loadAccountSession"]>[0]) {
    const rows = await this.sql<{ account_id: string; encrypted_session: Uint8Array; encryption_key_version: number }[]>`
      select account_id::text, encrypted_session, encryption_key_version
        from public.load_telegram_session_for_runtime(
          ${input.accountId}::uuid, ${input.leaseOwner}::uuid, ${input.fencingToken.toString()}::bigint
        )
       where account_type = 'MONITOR'
    `;
    const row = rows[0];
    return row ? Object.freeze({
      accountId: row.account_id,
      encryptedSession: Uint8Array.from(row.encrypted_session),
      encryptionKeyVersion: row.encryption_key_version,
    }) : null;
  }

  async loadSources(accountId: string): Promise<readonly CentralMonitorSource[]> {
    const rows = await this.sql<SourceRow[]>`
        with eligible_sources as (
          select source.*
            from public.auto_comment_monitor_sources source
           where exists (
             select 1
               from public.auto_comment_channel_targets configured_target
              where configured_target.monitor_source_id = source.id
                and configured_target.active
                and exists (
                  select 1 from public.userbot_profiles configured_profile
                   where configured_profile.user_id = configured_target.user_id
                     and configured_profile.active_account_id = configured_target.account_id
                     and configured_profile.status = 'CONNECTED'
                     and configured_profile.auto_comment_enabled
                )
                and exists (
                  select 1 from public.entitlements entitlement
                   where entitlement.user_id = configured_target.user_id
                     and entitlement.status = 'ACTIVE'
                     and entitlement.expires_at > now()
                     and entitlement.package_snapshot->>'packageType' = 'USERBOT'
                     and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
                )
           )
           and (source.monitor_account_id is null or source.monitor_account_id = ${accountId}::uuid
                or not exists (
                  select 1 from public.telegram_accounts assigned_monitor
                   where assigned_monitor.id = source.monitor_account_id
                     and assigned_monitor.account_type = 'MONITOR'
                     and assigned_monitor.status = 'READY'
                     and assigned_monitor.monitor_active
                ))
        )
        select source.id::text as source_id, source.source_channel_ref,
               source.provider_peer_id, source.last_post_id::text,
               matched.channel_target_id, matched.account_id,
               matched.division_id, matched.mode, matched.telegram_user_id,
               matched.discussion_target_ref,
               matched.central_monitor_start_post_id,
               matched.central_monitor_activated_at,
               matched.keywords, matched.template_id, matched.template_text
          from eligible_sources source
          left join lateral (
            select target.id::text as channel_target_id, target.account_id::text,
                   division.id::text as division_id, division.mode,
                   app_user.telegram_user_id::text,
                   target.discussion_target_ref,
                   target.central_monitor_start_post_id::text,
                   target.central_monitor_activated_at::text,
                   array(
                     select lower(btrim(keyword.keyword))
                       from public.auto_comment_division_keywords keyword
                      where keyword.division_id = division.id
                      order by keyword.created_at, keyword.id
                   ) as keywords,
                   selected_template.id::text as template_id,
                   selected_template.text_content as template_text,
                   division.created_at as division_created_at
              from public.auto_comment_channel_targets target
              join public.auto_comment_division_channels mapping on mapping.channel_target_id = target.id
              join public.auto_comment_divisions division on division.id = mapping.division_id
              join public.telegram_accounts userbot on userbot.id = target.account_id
              join public.userbot_profiles profile
                on profile.user_id = target.user_id and profile.active_account_id = target.account_id
              left join public.app_users app_user on app_user.id = target.user_id
              join lateral (
                select template.id, template.text_content
                  from public.auto_comment_division_templates template
                 where template.division_id = division.id and template.active
                 order by template.display_order, template.created_at, template.id
                 limit 1
              ) selected_template on true
             where target.monitor_source_id = source.id
               and target.active
               and target.resolution_status = 'READY'
               and target.discussion_target_ref is not null
               and division.active
               and userbot.account_type = 'USERBOT'
               and userbot.status = 'READY'
               and profile.status = 'CONNECTED'
               and profile.auto_comment_enabled
               and exists (
                 select 1 from public.auto_comment_division_keywords keyword
                  where keyword.division_id = division.id
               )
               and exists (
                 select 1 from public.entitlements entitlement
                  where entitlement.user_id = target.user_id
                    and entitlement.status = 'ACTIVE'
                    and entitlement.expires_at > now()
                    and entitlement.package_snapshot->>'packageType' = 'USERBOT'
                    and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
               )
          ) matched on true
         order by source.created_at, source.id, matched.division_created_at, matched.division_id
      `;

    const sources = new Map<string, { base: Omit<CentralMonitorSource, "divisions">; divisions: CentralMonitorDivision[] }>();
    for (const row of rows) {
      const current = sources.get(row.source_id) ?? {
        base: {
          sourceId: row.source_id,
          sourceChannelRef: row.source_channel_ref,
          providerPeerId: row.provider_peer_id,
          lastPostId: row.last_post_id === null ? null : Number(row.last_post_id),
        },
        divisions: [],
      };
      sources.set(row.source_id, current);
      if (
        row.channel_target_id === null
        || row.account_id === null
        || row.division_id === null
        || row.mode === null
        || row.discussion_target_ref === null
        || row.keywords === null
        || row.template_id === null
        || row.template_text === null
        || row.central_monitor_activated_at === null
      ) continue;
      current.divisions.push(Object.freeze({
        divisionId: row.division_id,
        accountId: row.account_id,
        telegramUserId: row.telegram_user_id === null ? null : Number(row.telegram_user_id),
        mode: row.mode,
        keywords: Object.freeze(row.keywords.map((value) => value.toLocaleLowerCase("id-ID"))),
        template: Object.freeze({ templateId: row.template_id, text: row.template_text }),
        channelTargetId: row.channel_target_id,
        discussionTargetRef: row.discussion_target_ref,
        startAfterPostId: row.central_monitor_start_post_id === null ? null : Number(row.central_monitor_start_post_id),
        activatedAt: new Date(row.central_monitor_activated_at).toISOString(),
      }));
    }
    return Object.freeze([...sources.values()].map(({ base, divisions }) => Object.freeze({
      ...base,
      divisions: Object.freeze(divisions),
    })));
  }

  async markSourceReady(input: Parameters<CentralMonitorRepository["markSourceReady"]>[0]) {
    await this.sql`
      update public.auto_comment_monitor_sources
         set provider_peer_id = ${input.providerPeerId}, monitor_account_id = ${input.accountId},
             status = 'READY', last_error_code = null, retry_at = null, updated_at = now()
       where id = ${input.sourceId}::uuid
    `;
  }

  async markSourceFailure(input: Parameters<CentralMonitorRepository["markSourceFailure"]>[0]) {
    await this.sql`
      update public.auto_comment_monitor_sources
         set monitor_account_id = ${input.accountId}::uuid,
             status = ${input.retryable ? "FAILED_RETRYABLE" : "ACCESS_REQUIRED"},
             last_error_code = ${input.errorCode},
             retry_at = ${input.retryable ? this.sql`now() + interval '30 seconds'` : this.sql`null`},
             updated_at = now()
       where id = ${input.sourceId}::uuid
    `;
  }

  async advanceCheckpoint(input: Parameters<CentralMonitorRepository["advanceCheckpoint"]>[0]) {
    await this.sql`
      with advanced as (
        update public.auto_comment_monitor_sources
           set last_post_id = greatest(coalesce(last_post_id, 0), ${input.providerPostId}),
               last_event_at = now(), updated_at = now()
         where id = ${input.sourceId}::uuid
        returning id
      )
      update public.auto_comment_channel_targets target
         set central_monitor_start_post_id = ${input.providerPostId}, updated_at = now()
        from advanced
       where target.monitor_source_id = advanced.id
         and target.central_monitor_start_post_id is null
    `;
  }

  async enqueueEvent(input: Parameters<CentralMonitorRepository["enqueueEvent"]>[0]) {
    const rows = await this.sql<EventRow[]>`
      insert into public.auto_comment_monitor_events (
        source_id, provider_post_id, content, provider_posted_at
      ) values (
        ${input.sourceId}::uuid, ${input.providerPostId}, ${input.content}, ${input.providerPostedAt}
      )
      on conflict (source_id, provider_post_id) do nothing
      returning id::text as event_id, source_id::text,
                provider_post_id::text, content, provider_posted_at::text
    `;
    if (!rows[0]) return null;
    return event({ ...rows[0], source_channel_ref: "" });
  }

  async listPendingEvents(limit: number) {
    const rows = await this.sql<EventRow[]>`
      select event.id::text as event_id, event.source_id::text,
             source.source_channel_ref, event.provider_post_id::text,
             event.content, event.provider_posted_at::text
        from public.auto_comment_monitor_events event
        join public.auto_comment_monitor_sources source on source.id = event.source_id
       where event.status = 'PENDING'
       order by event.received_at, event.id
       limit ${limit}
    `;
    return Object.freeze(rows.map(event));
  }

  async finishEvent(eventId: string, errorCode?: string) {
    await this.sql`
      update public.auto_comment_monitor_events
         set status = ${errorCode ? "PENDING" : "PROCESSED"},
             processed_at = ${errorCode ? this.sql`null` : this.sql`now()`},
             attempt_count = attempt_count + 1,
             last_error_code = ${errorCode ?? null},
             content = case when ${errorCode ?? null}::text is null then '' else content end
       where id = ${eventId}::uuid
    `;
  }

  async completeEvent(input: Parameters<CentralMonitorRepository["completeEvent"]>[0]) {
    await this.sql`
      with completed as (
        update public.auto_comment_monitor_events
           set status = 'PROCESSED', processed_at = now(),
               attempt_count = attempt_count + 1, last_error_code = null,
               content = ''
         where id = ${input.eventId}::uuid
           and source_id = ${input.sourceId}::uuid
        returning source_id
      ), advanced as (
        update public.auto_comment_monitor_sources source
           set last_post_id = greatest(coalesce(last_post_id, 0), ${input.providerPostId}),
               last_event_at = now(), updated_at = now()
          from completed
         where source.id = completed.source_id
        returning source.id
      )
      update public.auto_comment_channel_targets target
         set central_monitor_start_post_id = ${input.providerPostId}, updated_at = now()
        from advanced
       where target.monitor_source_id = advanced.id
         and target.central_monitor_start_post_id is null
    `;
  }

  async createCandidate(input: Parameters<CentralMonitorRepository["createCandidate"]>[0]) {
    const rows = await this.sql<{ result_status: CentralCandidateResult["status"]; candidate_id: string }[]>`
      select result_status, candidate_id::text
        from public.create_auto_comment_candidate(
          ${input.division.channelTargetId}::uuid,
          ${input.division.divisionId}::uuid,
          ${input.division.accountId}::uuid,
          ${input.source.sourceChannelRef},
          ${String(input.providerPostId)},
          ${input.content},
          ${input.matchedKeywords}::text[],
          ${input.division.template.templateId}::uuid,
          ${input.division.template.text},
          ${input.division.mode},
          ${input.division.discussionTargetRef}
        )
    `;
    const row = rows[0];
    if (!row) throw new Error("CENTRAL_CANDIDATE_NOT_RETURNED");
    return Object.freeze({ status: row.result_status, candidateId: row.candidate_id });
  }

  async recordNotification(candidateId: string, messageId: number) {
    await this.sql`
      update public.auto_comment_candidates
         set notification_message_id = ${messageId}
       where id = ${candidateId}::uuid and notification_message_id is null
    `;
  }

  async recordAccountResult(input: Parameters<CentralMonitorRepository["recordAccountResult"]>[0]) {
    const rows = await this.sql<{ recorded: boolean }[]>`
      select public.record_telegram_account_runtime_result(
        ${input.accountId}::uuid,
        ${input.leaseOwner}::uuid,
        ${input.fencingToken.toString()}::bigint,
        ${input.result},
        ${input.errorCode ?? null},
        ${input.retryAfterSeconds ?? null}
      ) recorded
    `;
    return rows[0]?.recorded ?? false;
  }

  async subscribeChanges(listener: () => void) {
    const handle = await this.sql.listen(CENTRAL_MONITOR_WAKEUP_CHANNEL, () => listener());
    return Object.freeze({ close: () => handle.unlisten() });
  }
}
