-- grant_credits(): a negative balance carries over into the monthly reset and renewals.
--
-- Problem (AUDIT-APP.md H4):
--   Credits are reserved from an estimate and settled to the real cost afterwards, without
--   a floor (settle_credits), so a call that costs more than its estimate can take the
--   balance below zero. 'monthly_reset' and 'renewal' then set the balance to the plan
--   allowance, so the debt disappeared on the 1st (or on the billing date): repeated
--   overruns were never paid for. The estimates now follow the request size (generate-site,
--   edit-element), which makes overruns small, but they can still happen (a retried build,
--   token-dense input).
--
-- Change:
--   'monthly_reset' and 'renewal': balance := allowance + least(balance, 0).
--   A positive leftover is still not carried over (unchanged); only a debt is.
--   All other reasons (plan_upgrade, referral_bonus, manual_correction) are unchanged:
--   balance := greatest(balance, allowance).
--
-- Unchanged: signature, privileges, the ledger row (delta = new - old, balance_after).

begin;

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
    -- A new period starts from the allowance; a debt from overruns is carried over.
    v_new := v_allowance + least(v_old, 0);
  else
    v_new := greatest(v_old, v_allowance);
  end if;

  update public.profiles set credit_balance = v_new where id = p_user_id;

  insert into public.credit_ledger (user_id, action_type, credits_charged, delta, balance_after)
  values (p_user_id, p_reason, 0, v_new - v_old, v_new);

  return v_new;
end;
$$;

revoke execute on function public.grant_credits(uuid, text) from public, anon, authenticated;
grant  execute on function public.grant_credits(uuid, text) to service_role;

commit;
