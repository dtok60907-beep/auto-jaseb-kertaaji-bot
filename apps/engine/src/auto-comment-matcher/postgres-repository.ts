import type { Sql } from "postgres";
import type {
  AutoCommentMatcherRepository,
  ClaimedAutoCommentMonitoringTarget,
  CreateCandidateResult,
  DivisionMatchConfig,
} from "./repository.ts";

type ClaimRow = {
  channel_target_id: string;
  source_channel_ref: string;
  discussion_target_ref: string;
  monitoring_last_post_id: string | null;
};
type DivisionRow = { id: string; account_id: string; name: string; mode: DivisionMatchConfig["mode"] };
type KeywordRow = { division_id: string; keyword: string };
type TemplateRow = { division_id: string; id: string; text_content: string };
type CandidateRow = { result_status: CreateCandidateResult["status"]; candidate_id: string };

export class PostgresAutoCommentMatcherRepository implements AutoCommentMatcherRepository {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async claimNext(input: Parameters<AutoCommentMatcherRepository["claimNext"]>[0]): Promise<ClaimedAutoCommentMonitoringTarget | null> {
    const rows = await this.sql<ClaimRow[]>`
      select channel_target_id::text, source_channel_ref, discussion_target_ref, monitoring_last_post_id::text
        from public.claim_next_auto_comment_monitoring(
          ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
          ${input.accountFencingToken.toString()}::bigint, ${input.pollIntervalSeconds}
        )
    `;
    const row = rows[0];
    if (!row) return null;
    return Object.freeze({
      channelTargetId: row.channel_target_id,
      sourceChannelRef: row.source_channel_ref,
      discussionTargetRef: row.discussion_target_ref,
      monitoringLastPostId: row.monitoring_last_post_id === null ? null : Number(row.monitoring_last_post_id),
    });
  }

  async divisionsFor(channelTargetId: string): Promise<readonly DivisionMatchConfig[]> {
    const [divisions, keywords, templates] = await Promise.all([
      this.sql<DivisionRow[]>`
        select division.id::text, division.account_id::text, division.name, division.mode
          from public.auto_comment_divisions division
          join public.auto_comment_division_channels mapping on mapping.division_id = division.id
         where mapping.channel_target_id = ${channelTargetId}::uuid
           and division.active
         order by division.created_at, division.id
      `,
      this.sql<KeywordRow[]>`
        select keyword.division_id::text, keyword.keyword
          from public.auto_comment_division_keywords keyword
          join public.auto_comment_division_channels mapping on mapping.division_id = keyword.division_id
         where mapping.channel_target_id = ${channelTargetId}::uuid
         order by keyword.created_at, keyword.id
      `,
      this.sql<TemplateRow[]>`
        select template.division_id::text, template.id::text, template.text_content
          from public.auto_comment_division_templates template
          join public.auto_comment_division_channels mapping on mapping.division_id = template.division_id
         where mapping.channel_target_id = ${channelTargetId}::uuid
           and template.active
         order by template.display_order, template.created_at, template.id
      `,
    ]);

    const keywordsByDivision = new Map<string, string[]>();
    for (const row of keywords) (keywordsByDivision.get(row.division_id) ?? keywordsByDivision.set(row.division_id, []).get(row.division_id)!).push(row.keyword);
    const templatesByDivision = new Map<string, Readonly<{ templateId: string; text: string }>[]>();
    for (const row of templates) (templatesByDivision.get(row.division_id) ?? templatesByDivision.set(row.division_id, []).get(row.division_id)!).push(Object.freeze({ templateId: row.id, text: row.text_content }));

    return Object.freeze(divisions.map((division) => Object.freeze({
      divisionId: division.id,
      accountId: division.account_id,
      name: division.name,
      mode: division.mode,
      keywords: Object.freeze(keywordsByDivision.get(division.id) ?? []),
      templates: Object.freeze(templatesByDivision.get(division.id) ?? []),
    })));
  }

  async createCandidate(input: Parameters<AutoCommentMatcherRepository["createCandidate"]>[0]): Promise<CreateCandidateResult> {
    const rows = await this.sql<CandidateRow[]>`
      select result_status, candidate_id::text
        from public.create_auto_comment_candidate(
          ${input.channelTargetId}::uuid, ${input.divisionId}::uuid, ${input.accountId}::uuid,
          ${input.sourceChannelRef}, ${input.providerPostId}, ${input.postContent},
          ${input.matchedKeywords}::text[], ${input.selectedTemplateId}::uuid, ${input.templateText},
          ${input.mode}, ${input.discussionTargetRef}
        )
    `;
    const row = rows[0];
    if (!row) throw new Error("auto comment candidate creation did not return a result");
    return Object.freeze({ status: row.result_status, candidateId: row.candidate_id });
  }

  async advanceCheckpoint(input: Parameters<AutoCommentMatcherRepository["advanceCheckpoint"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ advanced: boolean }[]>`
      select public.advance_auto_comment_monitoring_checkpoint(
        ${input.channelTargetId}::uuid, ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
        ${input.accountFencingToken.toString()}::bigint, ${input.lastPostId}
      ) advanced
    `;
    return rows[0]?.advanced ?? false;
  }
}
