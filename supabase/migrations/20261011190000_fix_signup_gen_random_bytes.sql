-- Fix: every signup fails with "Database error saving new user".
--
-- Cause: handle_new_user() (trigger on auth.users) calls gen_random_bytes() to build the
-- referral code. That function comes from pgcrypto, which Supabase installs in the
-- `extensions` schema, but handle_new_user() runs with `search_path = public`, so the
-- call fails with 42883 "function gen_random_bytes(integer) does not exist" and the
-- whole auth.users insert is rolled back. Introduced 2026-06-20 (commit 9329fa8,
-- referral system); the last successful signup in the live DB is 2026-06-19.
--
-- Fix: schema-qualify the call as extensions.gen_random_bytes(). The body is otherwise
-- copied unchanged from the live definition (pg_get_functiondef, 2026-10-11). The
-- search_path stays `public` (not widened) so the SECURITY DEFINER function keeps
-- resolving everything else only in public. Owner, privileges and the trigger
-- on_auth_user_created are untouched by CREATE OR REPLACE.

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free          bigint;
  v_code          text;
  v_referral_code text;
  v_referrer_id   uuid;
begin
  select value::bigint into v_free from public.config where key = 'credit_monthly_free';

  -- Generate unique referral code for new user.
  loop
    v_code := 'SF-' || upper(substring(encode(extensions.gen_random_bytes(4), 'hex'), 1, 6));
    exit when not exists (select 1 from public.profiles where referral_code = v_code);
  end loop;

  insert into public.profiles (id, email, credit_balance, referral_code)
  values (new.id, new.email, coalesce(v_free, 68000), v_code)
  on conflict (id) do update
    set referral_code = excluded.referral_code
    where profiles.referral_code is null;

  -- Handle referral code passed via signUp metadata (email signup path).
  v_referral_code := new.raw_user_meta_data->>'referral_code';
  if v_referral_code is not null then
    select id into v_referrer_id
      from public.profiles
     where referral_code = upper(v_referral_code);

    if v_referrer_id is not null and v_referrer_id != new.id then
      update public.profiles set referred_by = v_referrer_id where id = new.id;
      insert into public.referral_activations (referrer_id, referred_id)
      values (v_referrer_id, new.id)
      on conflict (referred_id) do nothing;
    elsif v_referrer_id = new.id then
      -- Self-referral: log as rejected.
      insert into public.referral_activations (referrer_id, referred_id, status, reject_reason)
      values (new.id, new.id, 'rejected', 'self_referral')
      on conflict (referred_id) do nothing;
    -- else: unknown code — no row inserted, silently ignore
    end if;
  end if;

  return new;
end;
$$;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- 1) New body is live (expect true):
-- select position('extensions.gen_random_bytes' in pg_get_functiondef('public.handle_new_user()'::regprocedure)) > 0;
--
-- 2) The qualified call resolves (expect a 6-char hex string):
-- select upper(substring(encode(extensions.gen_random_bytes(4), 'hex'), 1, 6));
--
-- 3) Then sign up a new test user in the app; a profiles row with credit_balance 68000
--    and a referral_code 'SF-XXXXXX' should appear.
