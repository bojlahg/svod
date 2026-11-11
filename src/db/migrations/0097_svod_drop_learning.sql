-- ═══════════════════════════════════════════════════════════════════════════
-- 0097 — SVOD stage 7: retire learning queues on upgrade from mozg.
--
-- Additive only in the application sense: no application tables or columns
-- are touched. Only pg-boss runtime state is cleaned:
--   - cancel unfinished `exam` jobs (created/retry/active), like pg-boss 10
--     cancelJobs does (state = 'cancelled', completed_on = now());
--   - delete schedules for retired queues so an already-running pg-boss
--     does not recreate work nobody consumes.
-- `svod-index` is never touched. pgboss schema and partitions stay.
-- Clean installs skip everything: if pgboss.job does not exist yet there is
-- nothing to cancel (worker creates queues on first boot).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';

-- ─── cancel unfinished exam jobs ────────────────────────────────────────────
-- pg-boss 10 cancelJobs (node_modules/pg-boss/src/plans.js):
--   UPDATE pgboss.job SET completed_on = now(), state = 'cancelled'
--   WHERE name = $1 AND id IN (...) AND state < 'completed'
-- Here: same SET, limited to unfinished exam states; completed/cancelled/
-- failed rows and every other queue (incl. svod-index) are untouched.
-- The job table is partitioned by name; updating the parent is allowed.
do $$
begin
  if to_regclass('pgboss.job') is not null then
    update pgboss.job
       set state = 'cancelled',
           completed_on = now()
     where name = 'exam'
       and state in ('created', 'retry', 'active');
  end if;
end $$;

-- ─── drop schedules for retired queues ──────────────────────────────────────
-- If pgboss.schedule is missing (clean install / old pg-boss), do nothing.
do $$
begin
  if to_regclass('pgboss.schedule') is not null then
    delete from pgboss.schedule
     where name in ('exam', 'ingest', 'crawl', 'maintenance', 'refresh',
                    'consolidate', 'contradict', 'lesson', 'summary',
                    'digest', 'mozgpay', 'generate');
  end if;
end $$;
