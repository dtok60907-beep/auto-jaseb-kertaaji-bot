-- Production baseline from Supabase advisors before F5.7b measurement.
-- Service-only tables intentionally keep RLS enabled without client policies.

-- Keep the original covering index; the later entitlement limit migration
-- accidentally recreated the same key under a second name.
drop index public.entitlements_active_limits_idx;

-- Cover every remaining foreign key used by cascades, validation, or joins.
create index auto_comment_candidates_channel_target_idx
  on public.auto_comment_candidates (channel_target_id);
create index auto_comment_candidates_incoming_post_idx
  on public.auto_comment_candidates (incoming_post_id);
create index auto_comment_candidates_selected_template_idx
  on public.auto_comment_candidates (selected_template_id);
create index auto_comment_channel_targets_account_idx
  on public.auto_comment_channel_targets (account_id);
create index auto_comment_channel_targets_user_idx
  on public.auto_comment_channel_targets (user_id);
create index auto_comment_divisions_account_idx
  on public.auto_comment_divisions (account_id);
create index auto_comment_divisions_user_idx
  on public.auto_comment_divisions (user_id);
create index auto_comment_reviews_decided_by_user_idx
  on public.auto_comment_reviews (decided_by_user_id);
create index broadcast_targets_source_lpm_target_idx
  on public.broadcast_targets (source_lpm_target_id);
create index comment_matches_incoming_post_idx
  on public.comment_matches (incoming_post_id);
create index entitlements_package_idx
  on public.entitlements (package_id);
create index package_catalog_created_by_idx
  on public.package_catalog (created_by);
create index package_catalog_current_version_idx
  on public.package_catalog (current_version_id);
create index package_versions_created_by_idx
  on public.package_versions (created_by);
create index userbot_profiles_active_account_idx
  on public.userbot_profiles (active_account_id);
create index workflow_commands_broadcast_target_idx
  on public.workflow_commands (broadcast_target_id);

-- Evaluate auth.uid() once per statement instead of once per row.
alter policy entitlements_owner_read on public.entitlements
  using (user_id = (select auth.uid()));
alter policy workflow_operations_owner_read on public.workflow_operations
  using (user_id = (select auth.uid()));
alter policy workflow_commands_owner_read on public.workflow_commands
  using (
    exists (
      select 1 from public.workflow_operations operation
       where operation.id = workflow_commands.operation_id
         and operation.user_id = (select auth.uid())
    )
  );
alter policy broadcast_targets_owner_read on public.broadcast_targets
  using (
    exists (
      select 1 from public.workflow_operations operation
       where operation.id = broadcast_targets.operation_id
         and operation.user_id = (select auth.uid())
    )
  );
alter policy comment_rules_owner_read on public.comment_rules
  using (user_id = (select auth.uid()));
alter policy comment_matches_owner_read on public.comment_matches
  using (
    exists (
      select 1 from public.comment_rules rule
       where rule.id = comment_matches.rule_id
         and rule.user_id = (select auth.uid())
    )
  );
alter policy broadcast_materials_owner_read on public.broadcast_materials
  using (user_id = (select auth.uid()));
alter policy broadcast_lpm_targets_owner_read on public.broadcast_lpm_targets
  using (user_id = (select auth.uid()));
alter policy auto_comment_divisions_owner_read on public.auto_comment_divisions
  using (user_id = (select auth.uid()));
alter policy auto_comment_division_keywords_owner_read on public.auto_comment_division_keywords
  using (
    exists (
      select 1 from public.auto_comment_divisions division
       where division.id = auto_comment_division_keywords.division_id
         and division.user_id = (select auth.uid())
    )
  );
alter policy auto_comment_division_templates_owner_read on public.auto_comment_division_templates
  using (
    exists (
      select 1 from public.auto_comment_divisions division
       where division.id = auto_comment_division_templates.division_id
         and division.user_id = (select auth.uid())
    )
  );
alter policy auto_comment_channel_targets_owner_read on public.auto_comment_channel_targets
  using (user_id = (select auth.uid()));
alter policy auto_comment_division_channels_owner_read on public.auto_comment_division_channels
  using (
    exists (
      select 1 from public.auto_comment_divisions division
       where division.id = auto_comment_division_channels.division_id
         and division.user_id = (select auth.uid())
    )
  );
alter policy auto_comment_candidates_owner_read on public.auto_comment_candidates
  using (
    exists (
      select 1 from public.auto_comment_divisions division
       where division.id = auto_comment_candidates.division_id
         and division.user_id = (select auth.uid())
    )
  );
alter policy auto_comment_reviews_owner_read on public.auto_comment_reviews
  using (
    exists (
      select 1
        from public.auto_comment_candidates candidate
        join public.auto_comment_divisions division on division.id = candidate.division_id
       where candidate.id = auto_comment_reviews.candidate_id
         and division.user_id = (select auth.uid())
    )
  );
alter policy userbot_profiles_owner_read on public.userbot_profiles
  using (user_id = (select auth.uid()));
alter policy userbot_profile_accounts_owner_read on public.userbot_profile_accounts
  using (
    exists (
      select 1 from public.userbot_profiles profile
       where profile.id = userbot_profile_accounts.profile_id
         and profile.user_id = (select auth.uid())
    )
  );
