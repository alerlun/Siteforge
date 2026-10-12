-- Database advisor warnings (AUDIT-APP.md L15).
--
-- 1. public.purge_rate_limits() has no fixed search_path ("Function Search Path
--    Mutable"). It is SECURITY INVOKER and only anon/authenticated lack EXECUTE, so the
--    risk is low, but a fixed search_path removes the warning and the class of issue.
--    Body, owner and privileges are unchanged.
--
-- 2. public.handle_new_user() is SECURITY DEFINER and executable by anon and
--    authenticated via /rest/v1/rpc/handle_new_user. It is a trigger function (on
--    auth.users insert): Postgres checks EXECUTE when the trigger is created, not when it
--    fires, so revoking client EXECUTE does not affect sign-up. Calling it over RPC fails
--    anyway (trigger functions cannot be called directly), so this only closes the
--    exposed endpoint and the warning.
--
-- Not changed: function bodies, the on_auth_user_created trigger, service_role access.

begin;

alter function public.purge_rate_limits() set search_path = public;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- select p.proname, p.proconfig,
--        has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_x,   -- false
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x    -- false
--   from pg_proc p
--  where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('purge_rate_limits', 'handle_new_user');
-- Then create a test account: sign-up must still create a profile row.
