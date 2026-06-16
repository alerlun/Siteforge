-- SiteForge schema
-- Run in Supabase SQL editor.

create extension if not exists "pgcrypto";
create extension if not exists "pg_cron";

-- plan enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'plan_tier') then
    create type public.plan_tier as enum ('free', 'pro');
  end if;
end$$;

-- profiles
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  plan public.plan_tier default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  leads_used integer default 0,
  generations_used integer default 0,
  created_at timestamptz default now()
);

-- Migration: convert existing text plan column to enum.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'plan' and data_type = 'text'
  ) then
    alter table public.profiles
      alter column plan drop default,
      alter column plan type public.plan_tier
        using (case when plan in ('free','pro') then plan::public.plan_tier else 'free'::public.plan_tier end),
      alter column plan set default 'free';
  end if;
end$$;

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
-- stripe_mode: 'test' | 'live' — switches which Stripe key set the edge functions use.
insert into public.config (key, value) values
  ('stripe_mode', 'test')
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

-- one chat session per lead: lets a business reopen its existing chat
alter table public.chat_sessions
  add column if not exists lead_id uuid references public.leads(id) on delete set null;

create unique index if not exists chat_sessions_lead_idx
  on public.chat_sessions (lead_id) where lead_id is not null;

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

-- ───────────── rate limiting (Postgres-backed; no external Redis) ─────────────
-- Fixed-window counters enforced atomically by check_rate_limit(). Edge Functions call
-- it through the service-role client (see _shared/ratelimit.ts). RLS is enabled with no
-- policies, so anon/auth roles get zero access — only the service role (which bypasses
-- RLS) can read or write counters.
create table if not exists public.rate_limits (
  key text primary key,
  count integer not null default 0,
  window_start timestamptz not null default now()
);

alter table public.rate_limits enable row level security;

create or replace function public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_window_start timestamptz;
  v_now timestamptz := now();
begin
  -- Single atomic upsert: open a fresh window when the previous one has expired,
  -- otherwise increment the existing counter. The row lock on conflict serialises
  -- concurrent requests for the same key, so the count is race-free.
  insert into public.rate_limits as rl (key, count, window_start)
  values (p_key, 1, v_now)
  on conflict (key) do update
    set count = case
          when rl.window_start < v_now - make_interval(secs => p_window_seconds) then 1
          else rl.count + 1
        end,
        window_start = case
          when rl.window_start < v_now - make_interval(secs => p_window_seconds) then v_now
          else rl.window_start
        end
  returning rl.count, rl.window_start into v_count, v_window_start;

  return query select
    v_count <= p_limit,
    greatest(0, p_limit - v_count),
    v_window_start + make_interval(secs => p_window_seconds);
end;
$$;

-- Purge expired counters hourly so the table stays small (the longest window is 1 min).
create or replace function public.purge_rate_limits()
returns void
language sql
as $$
  delete from public.rate_limits where window_start < now() - interval '1 hour';
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('siteforge_purge_rate_limits')
      where exists (select 1 from cron.job where jobname = 'siteforge_purge_rate_limits');
    perform cron.schedule(
      'siteforge_purge_rate_limits',
      '0 * * * *',
      $cron$select public.purge_rate_limits();$cron$
    );
  end if;
end;
$$;

-- ───────────── credits system ─────────────

-- Credit balance on profiles (replaces generations_used as the enforcement mechanism;
-- generations_used kept for stats/analytics).
alter table public.profiles
  add column if not exists credit_balance bigint default 0;

-- Credit rates and monthly allowances stored in config so they can be tuned without
-- a code deploy. All numeric values stored as text (config table is key-value).
insert into public.config (key, value) values
  ('credit_in_rate',      '1'),      -- credits charged per input token
  ('credit_out_rate',     '5'),      -- credits charged per output token
  ('credit_margin',       '1.1'),    -- overhead multiplier (10 % buffer)
  ('credit_monthly_free', '68000'),  -- ≈ 1 full generation
  ('credit_monthly_pro',  '680000')  -- ≈ 10 full generations
on conflict (key) do nothing;

-- Ledger: every Claude call records what was charged and why.
create table if not exists public.credit_ledger (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete cascade,
  action_type text not null,  -- 'generation' | 'edit' | 'element_edit' | 'classify'
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  credits_charged bigint not null default 0,
  site_id     uuid references public.generated_sites(id) on delete set null,
  created_at  timestamptz default now()
);

create index if not exists credit_ledger_user_idx
  on public.credit_ledger (user_id, created_at desc);

alter table public.credit_ledger enable row level security;

drop policy if exists "credit_ledger self read" on public.credit_ledger;
create policy "credit_ledger self read" on public.credit_ledger
  for select using (auth.uid() = user_id);

-- Atomically deduct credits; returns new balance (can go slightly negative on race).
create or replace function public.deduct_credits(
  p_user_id uuid,
  p_credits  bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
begin
  update profiles
    set credit_balance = credit_balance - p_credits
  where id = p_user_id
  returning credit_balance into v_balance;
  return v_balance;
end;
$$;

-- Update monthly reset to also restore credit balances from config.
create or replace function public.reset_monthly_counters()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free bigint;
  v_pro  bigint;
begin
  select value::bigint into v_free from public.config where key = 'credit_monthly_free';
  select value::bigint into v_pro  from public.config where key = 'credit_monthly_pro';

  update public.profiles set
    leads_used        = 0,
    generations_used  = 0,
    credit_balance    = case
      when plan = 'pro' then coalesce(v_pro,  680000)
      else                   coalesce(v_free,  68000)
    end;
end;
$$;

-- One-time migration: seed credit_balance for existing users who have never had credits.
do $$
declare
  v_free bigint;
  v_pro  bigint;
begin
  select value::bigint into v_free from public.config where key = 'credit_monthly_free';
  select value::bigint into v_pro  from public.config where key = 'credit_monthly_pro';

  update public.profiles set
    credit_balance = case
      when plan = 'pro' then coalesce(v_pro,  680000)
      else                   coalesce(v_free,  68000)
    end
  where credit_balance = 0 or credit_balance is null;
end;
$$;
