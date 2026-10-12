-- grant_credits(): a monthly reset or renewal keeps open reservations withheld.
--
-- Problem (AUDIT-APP.md L3, ARKITEKTUR 25):
--   reserve_credits() takes the estimate from the balance at once. If 'monthly_reset' or
--   'renewal' runs while a generation is still in flight, the balance is set to the
--   allowance and the withheld amount is forgotten. settle_credits() then adjusts by
--   (cost - reserved) and refund_credits() adds the reservation back, both on top of the
--   fresh allowance, so the user ends up with up to one estimate too many credits.
--
-- Change (only for 'monthly_reset' and 'renewal'):
--   balance := allowance + least(balance, 0) - (sum of this user's 'reserved' rows)
--   The settle/refund that follows then lands on the right number: a refund returns the
--   new balance to exactly the allowance, a settle charges the real cost to it.
--   Everything else from 20261012140000 is unchanged (debt carried over, positive
--   leftovers not carried, other reasons use greatest(balance, allowance)).
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
  v_reserved  bigint;
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
    -- Reservations still in flight were already taken from the old balance; keep them
    -- withheld so their settle/refund adjusts the new balance correctly.
    select coalesce(sum(credits_charged), 0) into v_reserved
      from public.credit_ledger
     where user_id = p_user_id and status = 'reserved';
    -- A new period starts from the allowance; a debt from overruns is carried over.
    v_new := v_allowance + least(v_old, 0) - v_reserved;
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
