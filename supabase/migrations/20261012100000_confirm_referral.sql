-- confirm_referral(): one atomic implementation of referral confirmation + milestone reward.
--
-- Problem (see ARKITEKTUR.md 8.2 point 8, CREDITS-ANALYS.md section D):
--   Two implementations confirmed referrals and behaved differently:
--   - process_referrals() (SQL, hourly cron): daily cap 10/referrer, balance :=
--     greatest(balance, Pro allowance).
--   - confirmReferral() (_shared/referral.ts, called from generate-site): no daily cap,
--     read-modify-write in several statements (two concurrent calls can count the same
--     referral twice), and it OVERWRITES the balance with the Pro allowance, which can
--     lower a higher balance.
--   Neither wrote a credit_ledger row for the milestone top-up.
--
-- Change:
--   confirm_referral(activation_id) does everything in one transaction:
--     - locks the activation; only a 'pending' one is confirmed (idempotent: a second
--       call returns false);
--     - enforces the daily cap (max 10 confirmations per referrer per 24 h; over the cap
--       the activation stays pending and the hourly cron confirms it later);
--     - increments referral_count; at every 5th: referral_milestone, pro_until +1 month
--       and grant_credits(referrer, 'referral_bonus') -> balance := greatest(balance,
--       Pro allowance) plus a ledger row.
--   process_referrals() (cron) now just calls confirm_referral() for each eligible row.
--   generate-site switches to confirm_referral() in the next step (Edge Function deploy).
--
-- Unchanged: eligibility (first_generation_at set and > 24 h old for the cron path),
-- the cron schedule, and process_referrals' signature/privileges.

begin;

create or replace function public.confirm_referral(p_activation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer  uuid;
  v_count     integer;
  v_milestone integer;
  v_earned    integer;
begin
  select referrer_id into v_referrer
    from public.referral_activations
   where id = p_activation_id and status = 'pending'
     for update;
  if not found then
    return false;  -- unknown, or already confirmed/rejected
  end if;

  -- Serialise confirmations per referrer so the cap and the count can't race.
  perform 1 from public.profiles where id = v_referrer for update;

  -- Daily cap (anti-burst-fraud): leave it pending for a later cron run.
  if (select count(*) from public.referral_activations
       where referrer_id = v_referrer
         and status = 'confirmed'
         and confirmed_at > now() - interval '24 hours') >= 10 then
    return false;
  end if;

  update public.referral_activations
     set status = 'confirmed', confirmed_at = now()
   where id = p_activation_id;

  update public.profiles
     set referral_count = coalesce(referral_count, 0) + 1
   where id = v_referrer
  returning referral_count, coalesce(referral_milestone, 0) into v_count, v_milestone;

  v_earned := (v_count / 5) * 5;
  if v_earned > v_milestone then
    update public.profiles
       set referral_milestone = v_earned,
           pro_until = greatest(coalesce(pro_until, now()), now()) + interval '1 month'
     where id = v_referrer;
    -- pro_until is now in the future, so effective_plan() = 'pro' and this tops up to
    -- the Pro allowance without ever lowering a higher balance.
    perform public.grant_credits(v_referrer, 'referral_bonus');
  end if;

  return true;
end;
$$;

create or replace function public.process_referrals()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_confirmed integer := 0;
begin
  for v_id in
    select id from public.referral_activations
     where status = 'pending'
       and first_generation_at is not null
       and first_generation_at < now() - interval '24 hours'
     order by first_generation_at
  loop
    if public.confirm_referral(v_id) then
      v_confirmed := v_confirmed + 1;
    end if;
  end loop;

  if v_confirmed > 0 then
    raise log 'process_referrals: confirmed % referrals', v_confirmed;
  end if;
end;
$$;

revoke execute on function public.confirm_referral(uuid) from public, anon, authenticated;
grant  execute on function public.confirm_referral(uuid) to service_role;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- 1) Only service_role may call confirm_referral; process_referrals unchanged (expect f,f,t twice):
-- select f,
--        has_function_privilege('anon',          f, 'EXECUTE'),
--        has_function_privilege('authenticated', f, 'EXECUTE'),
--        has_function_privilege('service_role',  f, 'EXECUTE')
--   from unnest(array['public.confirm_referral(uuid)', 'public.process_referrals()']) f;
--
-- 2) process_referrals now delegates (expect true):
-- select position('confirm_referral' in pg_get_functiondef('public.process_referrals()'::regprocedure)) > 0;
