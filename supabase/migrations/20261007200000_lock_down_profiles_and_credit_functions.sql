-- Lock down credit/plan manipulation from the client.
--
-- Problem (see CREDITS-ANALYS.md, section E):
--   1. "profiles self update" + table-wide UPDATE grant let any signed-in user set their
--      own credit_balance, plan, pro_until, leads_used, ... from the browser.
--   2. SECURITY DEFINER functions were executable by anon/authenticated through the
--      default PUBLIC grant: anyone could call deduct_credits() for any user (or with a
--      negative amount to add credits) and reset_monthly_counters() for everyone.
--
-- The app never writes to profiles from the browser (only Edge Functions via the
-- service role and the handle_new_user trigger do), so no client feature depends on
-- the removed privileges. Edge Functions use service_role, which is granted below.
-- pg_cron runs as the function owner (postgres) and is unaffected.

begin;

-- ── profiles: read-only for clients ─────────────────────────────────────────
drop policy if exists "profiles self update" on public.profiles;
drop policy if exists "profiles self insert" on public.profiles;  -- rows are created by handle_new_user()
revoke insert, update, delete on public.profiles from anon, authenticated;
-- "profiles self read" (select own row) is kept.

-- ── credit_ledger: read-only for clients (defence in depth; RLS already blocks writes) ──
revoke insert, update, delete on public.credit_ledger from anon, authenticated;

-- ── deduct_credits: reject negative / null amounts ──────────────────────────
-- Same signature and return type as before, so existing callers keep working.
-- 0 is allowed as a no-op (an Anthropic call can report 0 usage).
create or replace function public.deduct_credits(
  p_user_id uuid,
  p_credits bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
begin
  if p_credits is null or p_credits < 0 then
    raise exception 'deduct_credits: p_credits must be >= 0 (got %)', p_credits
      using errcode = '22023';
  end if;

  update profiles
    set credit_balance = credit_balance - p_credits
  where id = p_user_id
  returning credit_balance into v_balance;
  return v_balance;
end;
$$;

-- ── internal functions: server only ─────────────────────────────────────────
revoke execute on function public.deduct_credits(uuid, bigint)             from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.reset_monthly_counters()                 from public, anon, authenticated;
revoke execute on function public.process_referrals()                      from public, anon, authenticated;
revoke execute on function public.purge_rate_limits()                      from public, anon, authenticated;

-- Edge Functions call these two via the service-role client.
grant execute on function public.deduct_credits(uuid, bigint)             to service_role;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

commit;

-- ── Verification (run after applying; every row should be false) ───────────
-- select r,
--        has_table_privilege(r, 'public.profiles', 'UPDATE')                          as profiles_update,
--        has_table_privilege(r, 'public.profiles', 'INSERT')                          as profiles_insert,
--        has_table_privilege(r, 'public.credit_ledger', 'INSERT')                     as ledger_insert,
--        has_function_privilege(r, 'public.deduct_credits(uuid,bigint)', 'EXECUTE')   as deduct,
--        has_function_privilege(r, 'public.reset_monthly_counters()', 'EXECUTE')      as reset,
--        has_function_privilege(r, 'public.process_referrals()', 'EXECUTE')           as referrals,
--        has_function_privilege(r, 'public.check_rate_limit(text,integer,integer)', 'EXECUTE') as ratelimit
-- from unnest(array['anon', 'authenticated']) r;
--
-- And this should be true (Edge Functions still work):
-- select has_function_privilege('service_role', 'public.deduct_credits(uuid,bigint)', 'EXECUTE'),
--        has_function_privilege('service_role', 'public.check_rate_limit(text,integer,integer)', 'EXECUTE');
