-- One-time correction: top up the two manually upgraded Pro accounts.
--
-- Problem (see CREDITS-ANALYS.md, "Bevis från live-databasen" and section A point 4):
--   Both accounts were switched to plan = 'pro' by hand in the Supabase dashboard on
--   2026-10-06 (confirmed by the owner), after the 2026-10-01 monthly reset. Nothing
--   tops up on a plan change, so they still have the Free allowance (68 000) instead of
--   the Pro allowance (680 000). Neither has a Stripe customer.
--
-- Fix: grant_credits(id, 'manual_correction') for each, which sets the balance to
-- greatest(balance, Pro allowance) and writes a credit_ledger row (delta + balance_after)
-- in the same transaction. The ids are hard-coded on purpose: this is a one-off for these
-- two rows only. The plan guard makes it a no-op for an account that is no longer Pro.
--
-- State before (read-only check, 2026-10-11):
--   717e4fbe-9e9d-47d9-b1d6-454697cd28db  pro  68000  no Stripe
--   f81f804a-2b98-4058-a098-3b36da05e42d  pro  68000  no Stripe

begin;

select public.grant_credits(id, 'manual_correction')
  from public.profiles
 where id in ('717e4fbe-9e9d-47d9-b1d6-454697cd28db',
              'f81f804a-2b98-4058-a098-3b36da05e42d')
   and plan = 'pro';

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- Expect both at 680000, each with one manual_correction row: delta 612000, balance_after 680000.
-- select p.id, p.credit_balance, l.action_type, l.delta, l.balance_after, l.created_at
--   from public.profiles p
--   join public.credit_ledger l on l.user_id = p.id and l.action_type = 'manual_correction'
--  where p.id in ('717e4fbe-9e9d-47d9-b1d6-454697cd28db', 'f81f804a-2b98-4058-a098-3b36da05e42d');
