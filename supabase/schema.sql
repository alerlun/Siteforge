-- SiteForge schema
-- Run in Supabase SQL editor.

create extension if not exists "pgcrypto";
create extension if not exists "pg_cron";

-- profiles
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  plan text default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  leads_used integer default 0,
  generations_used integer default 0,
  created_at timestamptz default now()
);

-- generated_sites
create table if not exists public.generated_sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  business_name text,
  html_output text,
  status text default 'pending',
  sale_price numeric,
  client_location text,
  business_type text,
  created_at timestamptz default now()
);

-- leads
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  business_name text,
  phone text,
  address text,
  rating numeric,
  review_count integer,
  has_website boolean,
  website_url text,
  email text,
  business_type text,
  status text default 'new',
  created_at timestamptz default now()
);

-- Migration: add business_type to existing leads tables.
alter table public.leads
  add column if not exists business_type text;

-- config (singleton key-value table; service role only)
create table if not exists public.config (
  key text primary key,
  value text
);

-- Seed config rows (idempotent)
insert into public.config (key, value) values
  ('stripe_mode', 'test'),
  ('stripe_publishable_key', ''),
  ('stripe_webhook_secret', '')
on conflict (key) do nothing;

-- ───────────── RLS ─────────────
alter table public.profiles enable row level security;
alter table public.generated_sites enable row level security;
alter table public.leads enable row level security;
alter table public.config enable row level security;

drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "profiles self insert" on public.profiles;
create policy "profiles self insert" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "generated_sites self all" on public.generated_sites;
create policy "generated_sites self all" on public.generated_sites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "leads self all" on public.leads;
create policy "leads self all" on public.leads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- config: only service role can read/write. No policies = no anon/auth access.

-- chat_sessions / chat_messages — multi-thread chat history
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists chat_sessions_user_idx
  on public.chat_sessions (user_id, updated_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.chat_sessions(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  role text check (role in ('user', 'assistant')),
  content text,
  site_id uuid references public.generated_sites(id) on delete set null,
  created_at timestamptz default now()
);
create index if not exists chat_messages_session_idx
  on public.chat_messages (session_id, created_at);

alter table public.generated_sites
  add column if not exists session_id uuid references public.chat_sessions(id) on delete set null;

alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "chat_sessions self all" on public.chat_sessions;
create policy "chat_sessions self all" on public.chat_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "chat_messages self all" on public.chat_messages;
create policy "chat_messages self all" on public.chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ───────────── trigger: auto-create profile on signup ─────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────── monthly counter reset ─────────────
create or replace function public.reset_monthly_counters()
returns void
language sql
as $$
  update public.profiles set leads_used = 0, generations_used = 0;
$$;

-- Schedule first of every month, 00:00 UTC.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('siteforge_reset_monthly')
      where exists (select 1 from cron.job where jobname = 'siteforge_reset_monthly');
    perform cron.schedule(
      'siteforge_reset_monthly',
      '0 0 1 * *',
      $cron$select public.reset_monthly_counters();$cron$
    );
  end if;
end;
$$;
