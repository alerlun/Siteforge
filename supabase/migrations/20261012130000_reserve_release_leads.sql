-- reserve_leads() / release_leads(): atomic monthly lead quota.
--
-- Problem (AUDIT-APP.md H2):
--   scrape-leads read profiles.leads_used at the start of a search and wrote
--   leads_used = <value read> + <used> at the end. A search takes several seconds
--   (Google Places paging waits 2.2 s per page), so parallel searches all saw the same
--   remaining quota and the last write won: 20 parallel searches gave a Free account
--   ~200 leads (and 20x the Places cost) while leads_used ended at 10.
--
-- Change:
--   reserve_leads(user, amount, limit) locks the profile row and takes
--   min(amount, limit - leads_used) from the quota before any Google call. It returns
--   the number granted (0 = quota used up). The limit is passed in by scrape-leads
--   (PLAN_LIMITS for the effective plan), so the plan limits stay in one place.
--   release_leads(user, amount) gives back the part of a reservation a search did not
--   use (floored at 0, so a monthly reset during a search cannot go negative).
--
-- Unchanged: the monthly reset (reset_monthly_counters zeroes leads_used) and the
-- column itself. Only service_role (Edge Functions) can call the functions.

begin;

create or replace function public.reserve_leads(
  p_user_id uuid,
  p_amount  integer,
  p_limit   integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used    integer;
  v_granted integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'reserve_leads: p_amount must be > 0 (got %)', p_amount using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 0 then
    raise exception 'reserve_leads: p_limit must be >= 0 (got %)', p_limit using errcode = '22023';
  end if;

  select coalesce(leads_used, 0) into v_used
    from public.profiles
   where id = p_user_id
     for update;
  if not found then
    return 0;
  end if;

  v_granted := greatest(0, least(p_amount, p_limit - v_used));
  if v_granted > 0 then
    update public.profiles set leads_used = v_used + v_granted where id = p_user_id;
  end if;
  return v_granted;
end;
$$;

create or replace function public.release_leads(
  p_user_id uuid,
  p_amount  integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount is null or p_amount <= 0 then
    return;
  end if;
  update public.profiles
     set leads_used = greatest(0, coalesce(leads_used, 0) - p_amount)
   where id = p_user_id;
end;
$$;

revoke execute on function public.reserve_leads(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.release_leads(uuid, integer)          from public, anon, authenticated;
grant  execute on function public.reserve_leads(uuid, integer, integer) to service_role;
grant  execute on function public.release_leads(uuid, integer)          to service_role;

commit;
