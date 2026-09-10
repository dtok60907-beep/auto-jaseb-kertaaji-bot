import type { Sql } from "postgres";
import type {
  AutoCommentDecisionResult,
  AutoCommentChannelTargetView,
  AutoCommentDivisionView,
  AutoCommentSettingsRepository,
  AutoCommentSettingsView,
  SafeUserbotAccountView,
} from "./repository.ts";

type AccountRow = SafeUserbotAccountView;
type DivisionRow = {
  id: string;
  account_id: string;
  name: string;
  mode: "APPROVAL_REQUIRED" | "AUTO_SEND";
  active: boolean;
};
type KeywordRow = { id: string; division_id: string; keyword: string };
type TemplateRow = {
  id: string;
  division_id: string;
  text_content: string;
  display_order: number;
  active: boolean;
};
type ChannelRow = {
  id: string;
  account_id: string;
  source_channel_ref: string;
  discussion_target_ref: string | null;
  resolution_status: "QUEUED" | "CHECKING" | "JOINING" | "WAITING_APPROVAL" | "READY" | "NEEDS_REVALIDATION" | "FAILED_FINAL";
  last_error_code: string | null;
  active: boolean;
  monitor_status: AutoCommentChannelTargetView["monitorStatus"];
  monitor_error_code: string | null;
};
type MappingRow = { division_id: string; channel_target_id: string };

function divisionView(
  row: DivisionRow,
  keywords: readonly KeywordRow[] = [],
  templates: readonly TemplateRow[] = [],
  channelTargetIds: readonly string[] = [],
): AutoCommentDivisionView {
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    mode: row.mode,
    active: row.active,
    keywords: Object.freeze(keywords.map((keyword) => Object.freeze({ id: keyword.id, keyword: keyword.keyword }))),
    templates: Object.freeze(templates.map((template) => Object.freeze({
      id: template.id,
      text: template.text_content,
      displayOrder: template.display_order,
      active: template.active,
    }))),
    channelTargetIds: Object.freeze([...channelTargetIds]),
  });
}
function channelView(row: ChannelRow, divisionIds: readonly string[] = []): AutoCommentChannelTargetView {
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    sourceChannelRef: row.source_channel_ref,
    discussionTargetRef: row.discussion_target_ref,
    resolutionStatus: row.resolution_status,
    lastErrorCode: row.last_error_code,
    active: row.active,
    divisionIds: Object.freeze([...divisionIds]),
    monitorStatus: row.monitor_status,
    monitorErrorCode: row.monitor_error_code,
  });
}

export class PostgresAutoCommentSettingsRepository implements AutoCommentSettingsRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async listSettings(userId: string): Promise<AutoCommentSettingsView> {
    const [profiles, accounts, divisions, keywords, templates, channels, mappings] = await Promise.all([
      this.sql<{ auto_comment_enabled: boolean }[]>`
        select auto_comment_enabled from public.userbot_profiles where user_id = ${userId}::uuid
      `,
      this.sql<AccountRow[]>`
        select id::text, label, status
          from public.telegram_accounts
         where owner_user_id = ${userId}::uuid and account_type = 'USERBOT'
         order by created_at, id
      `,
      this.sql<DivisionRow[]>`
        select id::text, account_id::text, name, mode, active
          from public.auto_comment_divisions
         where user_id = ${userId}::uuid and deleted_at is null
         order by created_at, id
      `,
      this.sql<KeywordRow[]>`
        select keyword.id::text, keyword.division_id::text, keyword.keyword
          from public.auto_comment_division_keywords keyword
          join public.auto_comment_divisions division on division.id = keyword.division_id
         where division.user_id = ${userId}::uuid and division.deleted_at is null
         order by keyword.created_at, keyword.id
      `,
      this.sql<TemplateRow[]>`
        select template.id::text, template.division_id::text, template.text_content,
               template.display_order, template.active
          from public.auto_comment_division_templates template
          join public.auto_comment_divisions division on division.id = template.division_id
         where division.user_id = ${userId}::uuid and division.deleted_at is null
           and template.deleted_at is null
         order by template.display_order, template.created_at, template.id
      `,
      this.sql<ChannelRow[]>`
        select target.id::text, target.account_id::text, target.source_channel_ref,
               target.discussion_target_ref, target.resolution_status,
               target.last_error_code, target.active,
               source.status as monitor_status,
               source.last_error_code as monitor_error_code
          from public.auto_comment_channel_targets target
          join public.auto_comment_monitor_sources source on source.id = target.monitor_source_id
         where target.user_id = ${userId}::uuid and target.deleted_at is null
         order by target.created_at, target.id
      `,
      this.sql<MappingRow[]>`
        select mapping.division_id::text, mapping.channel_target_id::text
          from public.auto_comment_division_channels mapping
          join public.auto_comment_divisions division on division.id = mapping.division_id
          join public.auto_comment_channel_targets target on target.id = mapping.channel_target_id
         where division.user_id = ${userId}::uuid
           and division.deleted_at is null and target.deleted_at is null
         order by mapping.created_at, mapping.division_id, mapping.channel_target_id
      `,
    ]);

    const keywordsByDivision = new Map<string, KeywordRow[]>();
    const templatesByDivision = new Map<string, TemplateRow[]>();
    const channelsByDivision = new Map<string, string[]>();
    const divisionsByChannel = new Map<string, string[]>();
    for (const row of keywords) (keywordsByDivision.get(row.division_id) ?? keywordsByDivision.set(row.division_id, []).get(row.division_id)!).push(row);
    for (const row of templates) (templatesByDivision.get(row.division_id) ?? templatesByDivision.set(row.division_id, []).get(row.division_id)!).push(row);
    for (const row of mappings) {
      (channelsByDivision.get(row.division_id) ?? channelsByDivision.set(row.division_id, []).get(row.division_id)!).push(row.channel_target_id);
      (divisionsByChannel.get(row.channel_target_id) ?? divisionsByChannel.set(row.channel_target_id, []).get(row.channel_target_id)!).push(row.division_id);
    }

    return Object.freeze({
      enabled: profiles[0]?.auto_comment_enabled ?? false,
      accounts: Object.freeze(accounts.map((account) => Object.freeze({ ...account }))),
      divisions: Object.freeze(divisions.map((division) => divisionView(
        division,
        keywordsByDivision.get(division.id),
        templatesByDivision.get(division.id),
        channelsByDivision.get(division.id),
      ))),
      channelTargets: Object.freeze(channels.map((channel) => channelView(channel, divisionsByChannel.get(channel.id)))),
    });
  }

  async createDivision(input: Parameters<AutoCommentSettingsRepository["createDivision"]>[0]): Promise<AutoCommentDivisionView> {
    const rows = await this.sql<DivisionRow[]>`
      insert into public.auto_comment_divisions (user_id, account_id, name, mode, active)
      values (${input.userId}::uuid, ${input.division.accountId}::uuid, ${input.division.name}, ${input.division.mode}, ${input.division.active})
      returning id::text, account_id::text, name, mode, active
    `;
    if (!rows[0]) throw new Error("auto comment division was not persisted");
    return divisionView(rows[0]);
  }

  async updateDivision(input: Parameters<AutoCommentSettingsRepository["updateDivision"]>[0]): Promise<AutoCommentDivisionView | null> {
    const rows = await this.sql<DivisionRow[]>`
      update public.auto_comment_divisions
         set name = ${input.patch.name}, mode = ${input.patch.mode}, active = ${input.patch.active},
             version = version + 1
       where id = ${input.id}::uuid and user_id = ${input.userId}::uuid
         and deleted_at is null
      returning id::text, account_id::text, name, mode, active
    `;
    return rows[0] ? divisionView(rows[0]) : null;
  }

  async deleteDivision(input: Parameters<AutoCommentSettingsRepository["deleteDivision"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update public.auto_comment_divisions
         set active = false, deleted_at = now(), version = version + 1
       where id = ${input.id}::uuid and user_id = ${input.userId}::uuid and deleted_at is null
      returning id::text
    `;
    return rows.length === 1;
  }

  async createKeyword(input: Parameters<AutoCommentSettingsRepository["createKeyword"]>[0]): Promise<Readonly<{ id: string; keyword: string }> | null> {
    const rows = await this.sql<{ id: string; keyword: string }[]>`
      insert into public.auto_comment_division_keywords (division_id, keyword)
      select id, ${input.keyword}
        from public.auto_comment_divisions
       where id = ${input.divisionId}::uuid and user_id = ${input.userId}::uuid
         and deleted_at is null
      returning id::text, keyword
    `;
    return rows[0] ? Object.freeze(rows[0]) : null;
  }

  async deleteKeyword(input: Parameters<AutoCommentSettingsRepository["deleteKeyword"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from public.auto_comment_division_keywords keyword
       using public.auto_comment_divisions division
       where keyword.id = ${input.id}::uuid
         and keyword.division_id = ${input.divisionId}::uuid
         and division.id = keyword.division_id
         and division.user_id = ${input.userId}::uuid
         and division.deleted_at is null
      returning keyword.id::text
    `;
    return rows.length === 1;
  }

  async createTemplate(input: Parameters<AutoCommentSettingsRepository["createTemplate"]>[0]): Promise<AutoCommentDivisionView["templates"][number] | null> {
    const rows = await this.sql<TemplateRow[]>`
      insert into public.auto_comment_division_templates (division_id, text_content, display_order, active)
      select id, ${input.template.text}, ${input.template.displayOrder}, ${input.template.active}
        from public.auto_comment_divisions
       where id = ${input.divisionId}::uuid and user_id = ${input.userId}::uuid
         and deleted_at is null
      returning id::text, division_id::text, text_content, display_order, active
    `;
    return rows[0] ? divisionView({ id: "", account_id: "", name: "", mode: "APPROVAL_REQUIRED", active: true }, [], [rows[0]]).templates[0] : null;
  }

  async updateTemplate(input: Parameters<AutoCommentSettingsRepository["updateTemplate"]>[0]): Promise<AutoCommentDivisionView["templates"][number] | null> {
    const rows = await this.sql<TemplateRow[]>`
      update public.auto_comment_division_templates template
         set text_content = ${input.template.text}, display_order = ${input.template.displayOrder}, active = ${input.template.active}
        from public.auto_comment_divisions division
       where template.id = ${input.id}::uuid
         and template.division_id = ${input.divisionId}::uuid
         and division.id = template.division_id
         and division.user_id = ${input.userId}::uuid
         and division.deleted_at is null
         and template.deleted_at is null
      returning template.id::text, template.division_id::text, template.text_content, template.display_order, template.active
    `;
    return rows[0] ? divisionView({ id: "", account_id: "", name: "", mode: "APPROVAL_REQUIRED", active: true }, [], [rows[0]]).templates[0] : null;
  }

  async deleteTemplate(input: Parameters<AutoCommentSettingsRepository["deleteTemplate"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update public.auto_comment_division_templates template
         set active = false, deleted_at = now()
        from public.auto_comment_divisions division
       where template.id = ${input.id}::uuid
         and template.division_id = ${input.divisionId}::uuid
         and division.id = template.division_id
         and division.user_id = ${input.userId}::uuid
         and template.deleted_at is null
      returning template.id::text
    `;
    return rows.length === 1;
  }

  async createChannelTarget(input: Parameters<AutoCommentSettingsRepository["createChannelTarget"]>[0]): Promise<AutoCommentChannelTargetView> {
    const rows = await this.sql<ChannelRow[]>`
      with inserted as (
        insert into public.auto_comment_channel_targets (user_id, account_id, source_channel_ref, active)
        values (${input.userId}::uuid, ${input.target.accountId}::uuid, ${input.target.sourceChannelRef}, ${input.target.active})
        returning id, account_id, source_channel_ref, discussion_target_ref,
                  resolution_status, last_error_code, active, monitor_source_id
      )
      select inserted.id::text, inserted.account_id::text, inserted.source_channel_ref,
             inserted.discussion_target_ref, inserted.resolution_status,
             inserted.last_error_code, inserted.active,
             source.status as monitor_status, source.last_error_code as monitor_error_code
        from inserted
        join public.auto_comment_monitor_sources source on source.id = inserted.monitor_source_id
    `;
    if (!rows[0]) throw new Error("auto comment channel target was not persisted");
    return channelView(rows[0]);
  }

  async updateChannelTarget(input: Parameters<AutoCommentSettingsRepository["updateChannelTarget"]>[0]): Promise<AutoCommentChannelTargetView | null> {
    const rows = await this.sql<ChannelRow[]>`
      with updated as (
        update public.auto_comment_channel_targets
           set source_channel_ref = ${input.patch.sourceChannelRef}, active = ${input.patch.active},
               discussion_target_ref = null, resolution_status = 'QUEUED', last_error_code = null,
               resolution_available_at = now(), resolution_approval_requested_at = null,
               resolution_lease_owner = null, resolution_fencing_token = null
         where id = ${input.id}::uuid and user_id = ${input.userId}::uuid
           and deleted_at is null
        returning id, account_id, source_channel_ref, discussion_target_ref,
                  resolution_status, last_error_code, active, monitor_source_id
      )
      select updated.id::text, updated.account_id::text, updated.source_channel_ref,
             updated.discussion_target_ref, updated.resolution_status,
             updated.last_error_code, updated.active,
             source.status as monitor_status, source.last_error_code as monitor_error_code
        from updated
        join public.auto_comment_monitor_sources source on source.id = updated.monitor_source_id
    `;
    return rows[0] ? channelView(rows[0]) : null;
  }

  async deleteChannelTarget(input: Parameters<AutoCommentSettingsRepository["deleteChannelTarget"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update public.auto_comment_channel_targets
         set active = false, deleted_at = now()
       where id = ${input.id}::uuid and user_id = ${input.userId}::uuid and deleted_at is null
      returning id::text
    `;
    return rows.length === 1;
  }

  async attachChannel(input: Parameters<AutoCommentSettingsRepository["attachChannel"]>[0]): Promise<"ATTACHED" | "NOT_FOUND"> {
    const inserted = await this.sql<{ division_id: string }[]>`
      insert into public.auto_comment_division_channels (division_id, channel_target_id)
      select division.id, channel.id
        from public.auto_comment_divisions division
        join public.auto_comment_channel_targets channel
          on channel.id = ${input.channelTargetId}::uuid
         and channel.user_id = division.user_id
         and channel.account_id = division.account_id
         and division.deleted_at is null
         and channel.deleted_at is null
       where division.id = ${input.divisionId}::uuid
         and division.user_id = ${input.userId}::uuid
      on conflict do nothing
      returning division_id::text
    `;
    if (inserted.length === 1) return "ATTACHED";
    const existing = await this.sql<{ division_id: string }[]>`
      select mapping.division_id::text
        from public.auto_comment_division_channels mapping
        join public.auto_comment_divisions division on division.id = mapping.division_id
        join public.auto_comment_channel_targets channel on channel.id = mapping.channel_target_id
       where mapping.division_id = ${input.divisionId}::uuid
         and mapping.channel_target_id = ${input.channelTargetId}::uuid
         and division.user_id = ${input.userId}::uuid
         and channel.user_id = division.user_id
         and channel.account_id = division.account_id
         and division.deleted_at is null
         and channel.deleted_at is null
    `;
    return existing.length === 1 ? "ATTACHED" : "NOT_FOUND";
  }

  async detachChannel(input: Parameters<AutoCommentSettingsRepository["detachChannel"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ division_id: string }[]>`
      delete from public.auto_comment_division_channels mapping
       using public.auto_comment_divisions division
       where mapping.division_id = ${input.divisionId}::uuid
         and mapping.channel_target_id = ${input.channelTargetId}::uuid
         and division.id = mapping.division_id
         and division.user_id = ${input.userId}::uuid
         and division.deleted_at is null
      returning mapping.division_id::text
    `;
    return rows.length === 1;
  }

  async decideCandidate(input: Parameters<AutoCommentSettingsRepository["decideCandidate"]>[0]): Promise<AutoCommentDecisionResult> {
    const rows = await this.sql<{
      result_status: AutoCommentDecisionResult["status"];
      candidate_id: string;
      operation_id: string | null;
      command_id: string | null;
    }[]>`select * from public.decide_auto_comment_candidate(
      ${input.candidateId}::uuid, ${input.userId}::uuid, ${input.decision}
    )`;
    const row = rows[0];
    if (!row) throw new Error("auto comment decision did not return a result");
    return Object.freeze({
      status: row.result_status,
      candidateId: row.candidate_id,
      operationId: row.operation_id,
      commandId: row.command_id,
    });
  }

  async resolveOwnerId(telegramUserId: string): Promise<string | null> {
    const rows = await this.sql<{ id: string }[]>`
      select id::text from public.app_users where telegram_user_id = ${telegramUserId}::bigint
    `;
    return rows[0]?.id ?? null;
  }

  async setEnabled(input: Readonly<{ userId: string; enabled: boolean }>): Promise<boolean> {
    const rows = await this.sql<{ updated: boolean }[]>`
      select public.set_auto_comment_enabled(${input.userId}::uuid, ${input.enabled}) updated
    `;
    return rows[0]?.updated ?? false;
  }
}
