-- site_versions: keep the Editor's version history in the database.
--
-- Problem (reported 2026-10-12, follow-up to AUDIT-APP.md M6):
--   The Editor kept undo/redo/restore history only in React state. After leaving the
--   Editor (or reloading) the history was gone; only the version saved to
--   generated_sites.html_output survived.
--
-- Change:
--   New table public.site_versions, one row per Editor version of a site:
--     site_id  -> generated_sites(id), on delete cascade (deleting a site removes its history)
--     user_id  -> auth.users(id), on delete cascade (account deletion removes it)
--     html     the full page HTML of that version
--     label    short description ('Original' or the edit instruction)
--   The Editor appends a row per AI edit and reads the list back when it opens.
--   generated_sites.html_output stays the "current" version (Chat, Stats, download).
--   Versions are immutable: clients may read, add and delete their own rows, not update.
--
-- RLS: a user sees only their own rows, and can only add versions to a site they own.
-- anon gets no access.

begin;

create table if not exists public.site_versions (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.generated_sites(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  html       text not null,
  label      text,
  created_at timestamptz not null default now()
);

create index if not exists site_versions_site_created_idx
  on public.site_versions (site_id, created_at);

alter table public.site_versions enable row level security;

create policy "site_versions self read" on public.site_versions
  for select using (auth.uid() = user_id);

create policy "site_versions self insert" on public.site_versions
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.generated_sites s
       where s.id = site_id and s.user_id = auth.uid()
    )
  );

create policy "site_versions self delete" on public.site_versions
  for delete using (auth.uid() = user_id);

revoke all on public.site_versions from anon;
revoke update, truncate, references, trigger on public.site_versions from authenticated;
grant select, insert, delete on public.site_versions to authenticated;

commit;

-- ── Verification (read-only; run after applying) ────────────────────────────
-- select has_table_privilege('anon', 'public.site_versions', 'SELECT')          as anon_select,   -- false
--        has_table_privilege('authenticated', 'public.site_versions', 'UPDATE') as auth_update,   -- false
--        has_table_privilege('authenticated', 'public.site_versions', 'INSERT') as auth_insert;   -- true
-- select policyname, cmd from pg_policies where tablename = 'site_versions';                    -- 3 rows
