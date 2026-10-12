-- refund_stale_reservations(): give back credit reservations that were never settled.
--
-- Problem (AUDIT-APP.md L4, ARKITEKTUR 27):
--   generate-site and edit-element reserve an estimate (reserve_credits) and later settle
--   or refund it. If the function is killed in between (timeout, crash, deploy), the
--   ledger row stays 'reserved' and the user has paid the estimate for nothing. Nothing
--   cleaned these up. 0 such rows live when this was written.
--
-- Change:
--   - public.refund_stale_reservations(): refunds every 'reserved' row older than
--     15 minutes through the existing refund_credits() (same balance + ledger logic).
--     15 minutes is far above the Edge Function wall-clock limit, so a still-running
--     request is never refunded under its feet. Returns the number of rows refunded.
--   - pg_cron job 'siteforge_refund_stale_reservations', every 10 minutes.
--   service_role only, like the other credit functions.
--
-- Not changed: reserve_credits / settle_credits / refund_credits.

begin;

create or replace function public.refund_stale_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_count integer := 0;
begin
  for v_id in
    select id from public.credit_ledger
     where status = 'reserved'
       and created_at < now() - interval '15 minutes'
     order by created_at
  loop
    perform public.refund_credits(v_id);
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then
    raise log 'refund_stale_reservations: refunded % reservation(s)', v_count;
  end if;
  return v_count;
end;
$$;

revoke execute on function public.refund_stale_reservations() from public, anon, authenticated;
grant  execute on function public.refund_stale_reservations() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('siteforge_refund_stale_reservations')
      where exists (select 1 from cron.job where jobname = 'siteforge_refund_stale_reservations');
    perform cron.schedule(
      'siteforge_refund_stale_reservations',
      '*/10 * * * *',
      $cron$select public.refund_stale_reservations();$cron$
    );
  end if;
end;
$$;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- select jobname, schedule from cron.job where jobname = 'siteforge_refund_stale_reservations';
-- select count(*) from public.credit_ledger where status = 'reserved' and created_at < now() - interval '15 minutes';  -- 0
