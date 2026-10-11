-- reset_monthly_counters(): top up through grant_credits() and honour pro_until.
--
-- Problem (see CREDITS-ANALYS.md, section A, points 1, 5 and 6):
--   - The reset chose the allowance from `plan` only, so Pro granted via referral
--     (pro_until in the future, plan = 'free') was reset to the Free allowance.
--   - The reset left no trace: no ledger rows, and pg_cron only reports "1 row".
--
-- Change:
--   - leads_used / generations_used are still zeroed for everyone, as before.
--   - The balance of every profile is set via grant_credits(id, 'monthly_reset'), which
--     uses effective_plan(plan, pro_until) and writes one credit_ledger row per user
--     (delta + balance_after), in the same transaction.
--   - The number of profiles reset is written to the Postgres log (RAISE LOG, visible
--     in the dashboard's Postgres logs). The ledger rows are the per-user record.
--   - If any single grant fails, the whole reset rolls back and pg_cron marks the run
--     as "failed" in cron.job_run_details (previously a partial failure was impossible
--     to see). Nothing is swallowed.
--
-- Unchanged: function name, signature (returns void), owner, privileges (service_role
-- only, from migration 20261007200000) and the cron schedule '0 0 1 * *' (00:00 UTC).
-- Stripe subscribers are still reset here; moving them to invoice.paid is step 2c.

begin;

create or replace function public.reset_monthly_counters()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_count integer := 0;
begin
  update public.profiles set leads_used = 0, generations_used = 0;

  for v_id in select id from public.profiles order by id loop
    perform public.grant_credits(v_id, 'monthly_reset');
    v_count := v_count + 1;
  end loop;

  raise log 'reset_monthly_counters: reset % profiles', v_count;
end;
$$;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- 1) New definition is live (expect true):
-- select position('grant_credits' in pg_get_functiondef('public.reset_monthly_counters()'::regprocedure)) > 0;
--
-- 2) Privileges unchanged (expect false, false, true):
-- select has_function_privilege('anon',          'public.reset_monthly_counters()', 'EXECUTE'),
--        has_function_privilege('authenticated', 'public.reset_monthly_counters()', 'EXECUTE'),
--        has_function_privilege('service_role',  'public.reset_monthly_counters()', 'EXECUTE');
--
-- The function is NOT run here. First real run: pg_cron 2026-11-01 00:00 UTC. After it:
-- select action_type, delta, balance_after, created_at from public.credit_ledger
--  where action_type = 'monthly_reset' order by created_at desc;
