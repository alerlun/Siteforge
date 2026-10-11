-- Atomic credit reservation for AI calls: reserve -> settle | refund.
--
-- Problem (see CREDITS-ANALYS.md, sections D and F):
--   - generate-site / edit-element check the balance on a value read BEFORE a 30-90 s
--     AI call and deduct afterwards, so concurrent calls can all pass the check and
--     drive the balance negative.
--   - The deduction (deduct_credits RPC) and the ledger insert are two separate calls
--     whose errors are swallowed: a call can be free, or logged but not deducted.
--   - The ledger stores only input/output tokens, so credits_charged cannot be
--     recomputed (cache tokens are charged but not stored).
--
-- New flow (Edge Functions switch over in steps 3b/3c; until then nothing calls these):
--   1. reserve_credits(user, estimate, action) BEFORE the AI call
--        Atomically: balance -= estimate only if balance >= estimate, and insert a
--        ledger row with status 'reserved'. Returns the ledger row id, or NULL if the
--        balance is too low (-> the Edge Function answers 402).
--   2a. settle_credits(ledger_id, actual credits, tokens..., site_id) AFTER success
--        Atomically: balance -= (actual - estimate) and the same ledger row becomes
--        'settled' with the real cost, tokens, delta and balance_after.
--   2b. refund_credits(ledger_id) on failure
--        Atomically: balance += estimate, ledger row becomes 'refunded' (delta 0).
--   One ledger row per AI action, always written in the same transaction as the
--   balance change.
--
-- A reservation that is never settled or refunded (e.g. the Edge Function is killed)
-- stays 'reserved': the user has paid the estimate, nothing more. Such rows can be
-- found with status = 'reserved' and created_at older than a few minutes.
--
-- deduct_credits() is left in place for now (still used by the deployed functions);
-- it is removed in a later migration once 3b and 3c are deployed.

begin;

-- ── credit_ledger: status + cache token columns ─────────────────────────────
alter table public.credit_ledger
  add column if not exists status             text    not null default 'settled',
  add column if not exists cache_write_tokens integer not null default 0,
  add column if not exists cache_read_tokens  integer not null default 0;

alter table public.credit_ledger
  drop constraint if exists credit_ledger_status_check;
alter table public.credit_ledger
  add constraint credit_ledger_status_check check (status in ('reserved', 'settled', 'refunded'));

comment on column public.credit_ledger.status is
  'reserved = estimate withheld before an AI call; settled = final; refunded = AI call failed, estimate returned.';

-- Existing rows (3 deductions, grant rows) get 'settled' from the column default.

-- ── reserve_credits ─────────────────────────────────────────────────────────
create or replace function public.reserve_credits(
  p_user_id uuid,
  p_amount  bigint,
  p_action  text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
  v_id      uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'reserve_credits: p_amount must be > 0 (got %)', p_amount using errcode = '22023';
  end if;
  if p_action not in ('generation', 'edit', 'element_edit') then
    raise exception 'reserve_credits: unknown action %', p_action using errcode = '22023';
  end if;

  update public.profiles
     set credit_balance = credit_balance - p_amount
   where id = p_user_id
     and credit_balance >= p_amount
  returning credit_balance into v_balance;

  if not found then
    return null;  -- insufficient credits (or no such profile)
  end if;

  insert into public.credit_ledger (user_id, action_type, status, credits_charged, delta, balance_after)
  values (p_user_id, p_action, 'reserved', p_amount, -p_amount, v_balance)
  returning id into v_id;

  return v_id;
end;
$$;

-- ── settle_credits ──────────────────────────────────────────────────────────
-- The final cost may exceed the estimate; the balance can then go slightly negative.
-- That is accepted (the work is done) and is visible in the ledger.
create or replace function public.settle_credits(
  p_ledger_id          uuid,
  p_credits            bigint,
  p_input_tokens       integer,
  p_output_tokens      integer,
  p_cache_write_tokens integer,
  p_cache_read_tokens  integer,
  p_site_id            uuid
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_reserved bigint;
  v_balance  bigint;
begin
  if p_credits is null or p_credits < 0 then
    raise exception 'settle_credits: p_credits must be >= 0 (got %)', p_credits using errcode = '22023';
  end if;

  select user_id, credits_charged into v_user_id, v_reserved
    from public.credit_ledger
   where id = p_ledger_id and status = 'reserved'
     for update;
  if not found then
    raise exception 'settle_credits: no reserved ledger row %', p_ledger_id using errcode = 'P0002';
  end if;

  update public.profiles
     set credit_balance = credit_balance - (p_credits - v_reserved)
   where id = v_user_id
  returning credit_balance into v_balance;

  update public.credit_ledger
     set status             = 'settled',
         credits_charged    = p_credits,
         delta              = -p_credits,
         balance_after      = v_balance,
         input_tokens       = coalesce(p_input_tokens, 0),
         output_tokens      = coalesce(p_output_tokens, 0),
         cache_write_tokens = coalesce(p_cache_write_tokens, 0),
         cache_read_tokens  = coalesce(p_cache_read_tokens, 0),
         site_id            = p_site_id
   where id = p_ledger_id;

  return v_balance;
end;
$$;

-- ── refund_credits ──────────────────────────────────────────────────────────
create or replace function public.refund_credits(p_ledger_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_reserved bigint;
  v_balance  bigint;
begin
  select user_id, credits_charged into v_user_id, v_reserved
    from public.credit_ledger
   where id = p_ledger_id and status = 'reserved'
     for update;
  if not found then
    raise exception 'refund_credits: no reserved ledger row %', p_ledger_id using errcode = 'P0002';
  end if;

  update public.profiles
     set credit_balance = credit_balance + v_reserved
   where id = v_user_id
  returning credit_balance into v_balance;

  update public.credit_ledger
     set status          = 'refunded',
         credits_charged = 0,
         delta           = 0,
         balance_after   = v_balance
   where id = p_ledger_id;

  return v_balance;
end;
$$;

-- ── privileges: server only ─────────────────────────────────────────────────
revoke execute on function public.reserve_credits(uuid, bigint, text)                                    from public, anon, authenticated;
revoke execute on function public.settle_credits(uuid, bigint, integer, integer, integer, integer, uuid) from public, anon, authenticated;
revoke execute on function public.refund_credits(uuid)                                                  from public, anon, authenticated;
grant  execute on function public.reserve_credits(uuid, bigint, text)                                    to service_role;
grant  execute on function public.settle_credits(uuid, bigint, integer, integer, integer, integer, uuid) to service_role;
grant  execute on function public.refund_credits(uuid)                                                  to service_role;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- 1) New columns; all existing rows 'settled':
-- select status, count(*) from public.credit_ledger group by status;
--
-- 2) Only service_role may call the new functions (expect f,f,t for each):
-- select f,
--        has_function_privilege('anon',          f, 'EXECUTE'),
--        has_function_privilege('authenticated', f, 'EXECUTE'),
--        has_function_privilege('service_role',  f, 'EXECUTE')
--   from unnest(array['public.reserve_credits(uuid,bigint,text)',
--                     'public.settle_credits(uuid,bigint,integer,integer,integer,integer,uuid)',
--                     'public.refund_credits(uuid)']) f;
