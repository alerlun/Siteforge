-- Idempotent, atomic handlers for the Stripe events that change plan/credits.
--
-- Problem (see CREDITS-ANALYS.md, section A, points 2-3):
--   - checkout.session.completed only sets plan = 'pro'; the balance is not topped up
--     until the next monthly reset.
--   - invoice.paid (subscription renewal) is not handled at all.
--   - Stripe delivers events at least once and retries on non-2xx. Topping up on a
--     re-delivered event would reset a partly used balance, so each event must be
--     applied exactly once.
--
-- This migration only ADDS a table and two functions. Nothing calls them until the
-- stripe-webhook Edge Function is updated (step 2c-ii).
--
--   stripe_events                    one row per applied Stripe event id (dedup key)
--   stripe_apply_checkout(...)       record event + plan = 'pro' + Stripe ids
--                                    + grant_credits(user, 'plan_upgrade')
--   stripe_apply_renewal(...)        record event + grant_credits(user, 'renewal')
--
-- Each function runs in one transaction: either the event is recorded AND applied, or
-- neither (an exception rolls back both, the webhook returns 500, Stripe retries).
-- Both return true if applied, false if the event id was already applied (or, for a
-- renewal, no Pro profile has that Stripe customer id).
--
-- Decided 2026-10-11: failed payments do NOT downgrade (Stripe retries, then sends
-- customer.subscription.deleted, which the webhook already handles), and a downgrade
-- keeps the remaining balance until the next monthly reset.

begin;

-- ── stripe_events ───────────────────────────────────────────────────────────
create table if not exists public.stripe_events (
  id          text primary key,           -- Stripe event id (evt_...)
  type        text not null,
  user_id     uuid references public.profiles(id) on delete set null,
  received_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;  -- no policies: service_role only
revoke all on public.stripe_events from anon, authenticated;

-- ── stripe_apply_checkout ───────────────────────────────────────────────────
create or replace function public.stripe_apply_checkout(
  p_event_id        text,
  p_user_id         uuid,
  p_customer_id     text,
  p_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.stripe_events (id, type, user_id)
  values (p_event_id, 'checkout.session.completed', p_user_id)
  on conflict (id) do nothing;
  if not found then
    return false;  -- already applied
  end if;

  update public.profiles
     set plan                   = 'pro',
         stripe_customer_id     = p_customer_id,
         stripe_subscription_id = p_subscription_id
   where id = p_user_id;
  if not found then
    raise exception 'stripe_apply_checkout: no profile for user %', p_user_id using errcode = 'P0002';
  end if;

  perform public.grant_credits(p_user_id, 'plan_upgrade');
  return true;
end;
$$;

-- ── stripe_apply_renewal ────────────────────────────────────────────────────
-- Only for invoice.paid with billing_reason = 'subscription_cycle' (the webhook filters).
create or replace function public.stripe_apply_renewal(
  p_event_id    text,
  p_customer_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  select id into v_user_id
    from public.profiles
   where stripe_customer_id = p_customer_id
     and plan = 'pro'
   limit 1;

  insert into public.stripe_events (id, type, user_id)
  values (p_event_id, 'invoice.paid', v_user_id)
  on conflict (id) do nothing;
  if not found then
    return false;  -- already applied
  end if;

  if v_user_id is null then
    raise log 'stripe_apply_renewal: no pro profile for customer % (event %)', p_customer_id, p_event_id;
    return false;  -- recorded, nothing to top up
  end if;

  perform public.grant_credits(v_user_id, 'renewal');
  return true;
end;
$$;

-- ── privileges: server only ─────────────────────────────────────────────────
revoke execute on function public.stripe_apply_checkout(text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.stripe_apply_renewal(text, text)              from public, anon, authenticated;
grant  execute on function public.stripe_apply_checkout(text, uuid, text, text) to service_role;
grant  execute on function public.stripe_apply_renewal(text, text)              to service_role;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- 1) Table exists, RLS on, clients have no access (expect true, false, false):
-- select c.relrowsecurity,
--        has_table_privilege('authenticated', 'public.stripe_events', 'SELECT'),
--        has_table_privilege('anon',          'public.stripe_events', 'SELECT')
--   from pg_class c where c.oid = 'public.stripe_events'::regclass;
--
-- 2) Only service_role may call the handlers (expect f,f,t for each):
-- select f,
--        has_function_privilege('anon',          f, 'EXECUTE'),
--        has_function_privilege('authenticated', f, 'EXECUTE'),
--        has_function_privilege('service_role',  f, 'EXECUTE')
--   from unnest(array['public.stripe_apply_checkout(text,uuid,text,text)',
--                     'public.stripe_apply_renewal(text,text)']) f;
