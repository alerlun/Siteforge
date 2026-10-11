-- grant_credits(): the single way to top up / reset a user's credit balance.
--
-- Problem (see CREDITS-ANALYS.md, sections A and D):
--   Balance top-ups (monthly reset, plan upgrade, referral bonus, manual fixes) write
--   profiles.credit_balance directly and never touch credit_ledger, so the balance and
--   the ledger cannot be reconciled, and nothing tops up when a plan changes mid-month.
--
-- This migration only ADDS things; no existing caller changes behaviour yet:
--   1. credit_ledger gets two nullable columns: delta (signed change to the balance)
--      and balance_after. Existing deduction rows are backfilled with
--      delta = -credits_charged (balance_after stays null: it was never recorded).
--   2. effective_plan(plan, pro_until): 'pro' if plan = 'pro' OR pro_until is in the
--      future. Same rule as the client's isProUser() (src/lib/auth.jsx:75-80).
--   3. grant_credits(user, reason): locks the profile row, sets the new balance and
--      writes a ledger row in the same transaction. Server-only (service_role / cron).
--
-- Callers are switched over in later, separate steps:
--   2b reset_monthly_counters(), 2c stripe-webhook, 2d one-time fix of the two Pro accounts.

begin;

-- ── 1. credit_ledger: signed delta + resulting balance ──────────────────────
alter table public.credit_ledger
  add column if not exists delta         bigint,
  add column if not exists balance_after bigint;

comment on column public.credit_ledger.delta is
  'Signed change to profiles.credit_balance (negative = deduction, positive = top-up).';
comment on column public.credit_ledger.balance_after is
  'profiles.credit_balance right after this row was applied (null for rows before 2026-10-11).';

update public.credit_ledger
   set delta = -credits_charged
 where delta is null
   and action_type in ('generation', 'edit', 'element_edit', 'classify');

-- ── 2. effective_plan ───────────────────────────────────────────────────────
create or replace function public.effective_plan(p_plan public.plan_tier, p_pro_until timestamptz)
returns public.plan_tier
language sql
stable
set search_path = public
as $$
  select case
    when p_plan = 'pro' or (p_pro_until is not null and p_pro_until > now()) then 'pro'::public.plan_tier
    else 'free'::public.plan_tier
  end;
$$;

-- ── 3. grant_credits ────────────────────────────────────────────────────────
-- Reasons and how the new balance is computed (allowance = config value for the
-- user's effective plan):
--   'monthly_reset', 'renewal'                       -> balance := allowance
--        (new period: no rollover; also clears a negative balance)
--   'plan_upgrade', 'referral_bonus', 'manual_correction' -> balance := greatest(balance, allowance)
--        (mid-period top-up: never lowers a higher balance)
-- Returns the new balance. Raises if the user does not exist or the reason is unknown.
create or replace function public.grant_credits(p_user_id uuid, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan      public.plan_tier;
  v_pro_until timestamptz;
  v_old       bigint;
  v_allowance bigint;
  v_new       bigint;
begin
  if p_reason not in ('monthly_reset', 'renewal', 'plan_upgrade', 'referral_bonus', 'manual_correction') then
    raise exception 'grant_credits: unknown reason %', p_reason using errcode = '22023';
  end if;

  -- Lock the row so a concurrent deduction cannot interleave with the read-modify-write.
  select plan, pro_until, coalesce(credit_balance, 0)
    into v_plan, v_pro_until, v_old
    from public.profiles
   where id = p_user_id
     for update;

  if not found then
    raise exception 'grant_credits: no profile for user %', p_user_id using errcode = 'P0002';
  end if;

  if public.effective_plan(v_plan, v_pro_until) = 'pro' then
    select value::bigint into v_allowance from public.config where key = 'credit_monthly_pro';
    v_allowance := coalesce(v_allowance, 680000);
  else
    select value::bigint into v_allowance from public.config where key = 'credit_monthly_free';
    v_allowance := coalesce(v_allowance, 68000);
  end if;

  if p_reason in ('monthly_reset', 'renewal') then
    v_new := v_allowance;
  else
    v_new := greatest(v_old, v_allowance);
  end if;

  update public.profiles set credit_balance = v_new where id = p_user_id;

  insert into public.credit_ledger (user_id, action_type, credits_charged, delta, balance_after)
  values (p_user_id, p_reason, 0, v_new - v_old, v_new);

  return v_new;
end;
$$;

-- ── privileges: server only ─────────────────────────────────────────────────
revoke execute on function public.grant_credits(uuid, text)                    from public, anon, authenticated;
grant  execute on function public.grant_credits(uuid, text)                    to service_role;
-- effective_plan is a harmless pure helper; keep it callable by everyone so the
-- client can later use the same rule (step 4).

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- 1) New columns exist and old rows are backfilled (expect 3 rows, delta = -credits_charged):
-- select action_type, credits_charged, delta, balance_after from public.credit_ledger order by created_at;
--
-- 2) Clients cannot call grant_credits, service_role can (expect false, false, true):
-- select has_function_privilege('anon',          'public.grant_credits(uuid,text)', 'EXECUTE'),
--        has_function_privilege('authenticated', 'public.grant_credits(uuid,text)', 'EXECUTE'),
--        has_function_privilege('service_role',  'public.grant_credits(uuid,text)', 'EXECUTE');
--
-- 3) effective_plan (expect pro, pro, free):
-- select public.effective_plan('pro', null),
--        public.effective_plan('free', now() + interval '1 day'),
--        public.effective_plan('free', now() - interval '1 day');
--
-- grant_credits itself is NOT called here; the first real call is the one-time fix in step 2d.
