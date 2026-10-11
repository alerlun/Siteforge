-- Remove client table privileges on internal tables (defence in depth).
--
-- Problem (ARKITEKTUR.md 8.1 point 3b): anon and authenticated still hold the Supabase
-- default SELECT/INSERT/UPDATE/DELETE on config, rate_limits and referral_activations.
-- Today only RLS stops them (no permissive policies). If RLS were ever disabled or a
-- broad policy added by mistake, clients could read config.stripe_webhook_secret, change
-- the credit rates, reset rate-limit counters or forge referrals.
--
-- Verified before writing (2026-10-11): nothing in src/ reads or writes these tables
-- directly. Edge Functions and scripts/stripe-switch.js use the service role, which is
-- not affected. referral_activations keeps SELECT so its existing "self read" policy
-- (referrer or referred may read their own rows) stays meaningful.

begin;

revoke all on public.config      from anon, authenticated;
revoke all on public.rate_limits from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.referral_activations from anon, authenticated;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- Expect: config and rate_limits empty for both roles; referral_activations only S.
-- select r, t,
--        concat_ws(',',
--          case when has_table_privilege(r, 'public.'||t, 'SELECT') then 'S' end,
--          case when has_table_privilege(r, 'public.'||t, 'INSERT') then 'I' end,
--          case when has_table_privilege(r, 'public.'||t, 'UPDATE') then 'U' end,
--          case when has_table_privilege(r, 'public.'||t, 'DELETE') then 'D' end) privs
--   from unnest(array['anon', 'authenticated']) r,
--        unnest(array['config', 'rate_limits', 'referral_activations']) t;
