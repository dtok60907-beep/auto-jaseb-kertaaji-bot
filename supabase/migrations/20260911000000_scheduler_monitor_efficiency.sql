-- The event-driven campaign scheduler used a statement-level trigger. The
-- UPDATE inside due_broadcast_campaigns fired it even when zero campaigns were
-- due, producing a NOTIFY -> scheduler -> UPDATE -> NOTIFY feedback loop.
-- Row-level notification preserves immediate wakeups for real mutations while
-- making an empty/idle due scan silent.
drop trigger if exists broadcast_campaigns_scheduler_wakeup on public.broadcast_campaigns;

create trigger broadcast_campaigns_scheduler_wakeup
after insert or update or delete on public.broadcast_campaigns
for each row execute function public.notify_broadcast_campaign_scheduler();

comment on trigger broadcast_campaigns_scheduler_wakeup on public.broadcast_campaigns is
  'Wakes the event-driven scheduler only when a campaign row actually changes; empty due scans must not self-notify.';
