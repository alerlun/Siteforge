-- leads.place_id: remember which Google place a lead came from, one lead per place per user.
--
-- Problem (AUDIT-APP.md M9):
--   scrape-leads did not store the Google place_id and never checked for duplicates, so two
--   similar searches ("frisör Karlstad" / "frisörer Karlstad") saved the same business again
--   and charged the lead quota twice.
--
-- Change:
--   - New nullable column leads.place_id (text). place_id is also the only Places field
--     Google allows to be stored without a time limit (see AUDIT-APP.md M11).
--   - Unique index (user_id, place_id). Existing rows have place_id = null, and nulls never
--     conflict, so the index builds on the current data without touching it.
--   scrape-leads then skips places the user already has (before the Details call) and
--   inserts with ON CONFLICT DO NOTHING for concurrent searches.
--
-- Not changed: RLS policies and grants on leads; existing rows (no backfill: their place_id
-- is unknown).

begin;

alter table public.leads add column if not exists place_id text;

create unique index if not exists leads_user_place_uidx
  on public.leads (user_id, place_id);

commit;
