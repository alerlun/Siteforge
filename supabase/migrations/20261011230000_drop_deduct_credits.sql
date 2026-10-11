-- Remove deduct_credits(): replaced by reserve_credits / settle_credits / refund_credits.
--
-- deduct_credits() changed the balance without writing the ledger and was called
-- best-effort with errors swallowed (CREDITS-ANALYS.md, sections D and F). Since
-- 2026-10-11 generate-site (v40) and edit-element (v10) use the reservation flow
-- from migration 20261011220000.
--
-- Verified before writing (2026-10-11): no caller left in src/, supabase/functions/,
-- scripts/, the deployed Edge Functions, any other public function, or pg_cron.
-- Owner-approved deletion. To restore: see the definition in migration
-- 20261007200000_lock_down_profiles_and_credit_functions.sql.

begin;

drop function if exists public.deduct_credits(uuid, bigint);

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- Expect 0:
-- select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'deduct_credits';
