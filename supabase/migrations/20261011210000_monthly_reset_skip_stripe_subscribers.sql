-- reset_monthly_counters(): stop topping up active Stripe subscribers.
--
-- Since stripe-webhook v24 (deployed 2026-10-11), Stripe subscribers are topped up on
-- their own billing date via invoice.paid -> stripe_apply_renewal() -> grant_credits
-- ('renewal'). If the 1st-of-month cron also reset them, a subscriber would get two
-- top-ups per period and the cron reset could wipe a balance that was just renewed.
--
-- Verified before writing (2026-10-11, Stripe API, read-only): the live and the test
-- webhook endpoints are enabled and subscribed to checkout.session.completed,
-- invoice.paid and customer.subscription.deleted.
--
-- Change: the credit top-up skips profiles with plan = 'pro' AND a stripe_subscription_id.
-- Everyone else is still reset on the 1st: Free users, Pro via referral (pro_until),
-- and Pro set by hand without Stripe. leads_used / generations_used are still zeroed for
-- everyone (lead quotas stay calendar-monthly).
--
-- When a subscription ends, stripe-webhook (customer.subscription.deleted) sets
-- plan = 'free' and clears stripe_subscription_id, so that user is picked up again by
-- the next monthly reset. Signature, privileges and cron schedule are unchanged.

begin;

create or replace function public.reset_monthly_counters()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_count   integer := 0;
  v_skipped integer;
begin
  update public.profiles set leads_used = 0, generations_used = 0;

  for v_id in
    select id from public.profiles
     where not (plan = 'pro' and stripe_subscription_id is not null)
     order by id
  loop
    perform public.grant_credits(v_id, 'monthly_reset');
    v_count := v_count + 1;
  end loop;

  select count(*) into v_skipped
    from public.profiles
   where plan = 'pro' and stripe_subscription_id is not null;

  raise log 'reset_monthly_counters: reset % profiles, skipped % Stripe subscribers (renewed via invoice.paid)',
    v_count, v_skipped;
end;
$$;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- 1) New definition is live (expect true):
-- select position('stripe_subscription_id is not null' in pg_get_functiondef('public.reset_monthly_counters()'::regprocedure)) > 0;
--
-- 2) Privileges unchanged (expect false, false, true):
-- select has_function_privilege('anon',          'public.reset_monthly_counters()', 'EXECUTE'),
--        has_function_privilege('authenticated', 'public.reset_monthly_counters()', 'EXECUTE'),
--        has_function_privilege('service_role',  'public.reset_monthly_counters()', 'EXECUTE');
--
-- 3) Who would be skipped today (expect 0 rows on 2026-10-11 — no Stripe subscribers yet):
-- select id from public.profiles where plan = 'pro' and stripe_subscription_id is not null;
