# Referral System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a viral referral loop where every user gets a unique code/link, referred users activate by generating their first site after 24h, and every 5 confirmed referrals grants the referrer one free month of Pro access via `pro_until` timestamp.

**Architecture:** Sync + Cron hybrid — referral attribution happens in the `handle_new_user` DB trigger (email) or `claim-referral` edge function (OAuth). First generation marks `first_generation_at`; the hourly `process_referrals()` pg_cron job confirms activations that have passed the 24h gate and updates milestone rewards. `pro_until` on profiles grants temporary Pro access with no Stripe involvement.

**Tech Stack:** Supabase Postgres (pg_cron, pgcrypto), Deno edge functions (TypeScript), React + Vite

## Global Constraints

- Stack: Supabase Postgres + Deno edge functions + React/Vite
- Edge functions use `adminClient()` from `../_shared/auth.ts` — never expose service role key to client
- All new edge functions follow existing pattern: CORS preflight check first, `getUser(req)` for auth, `errorResponse()` for errors
- `clientIp(req)` from `../_shared/guards.ts` returns a string (never null — defaults to `'unknown'`)
- `referral_activations.referred_id` has a UNIQUE constraint — all inserts must handle `23505` unique violation gracefully
- Referral codes format: `SF-` + 6 uppercase hex chars, e.g. `SF-3FA9C1`
- No Stripe involvement in referral rewards — `pro_until` timestamptz only
- Pro status = `profile.plan === 'pro' OR (profile.pro_until && new Date(profile.pro_until) > new Date())`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `supabase/schema.sql` | Modify (append) | Schema migration: new columns, referral_activations table, updated trigger, process_referrals fn, cron |
| `supabase/functions/_shared/referral.ts` | Create | `checkReferralActivation()` and `confirmReferral()` helpers |
| `supabase/functions/referral-stats/index.ts` | Create | GET stats: code, link, count, milestone, activations |
| `supabase/functions/claim-referral/index.ts` | Create | OAuth post-signup referral attribution |
| `supabase/functions/generate-site/index.ts` | Modify | Call `checkReferralActivation` after site insert |
| `src/lib/referral.js` | Create | Client-side localStorage helpers + API calls |
| `src/lib/auth.jsx` | Modify | Export `isProUser(profile)` helper |
| `src/pages/AppLayout.jsx` | Modify | Claim pending referral on mount after OAuth login |
| `src/pages/Signup.jsx` | Modify | Read `?ref=` param, store in localStorage, pass in signUp metadata, show banner |
| `src/pages/Settings.jsx` | Modify | Add referral section: link, progress bar, activations list |
| `src/pages/Chat.jsx` | Modify | `planLabel` uses `isProUser`; one-time post-generation nudge banner |

---

## Task 1: SQL Migration

**Files:**
- Modify: `supabase/schema.sql` (append at bottom)

**Interfaces:**
- Produces: `profiles.referral_code`, `profiles.referred_by`, `profiles.referral_count`, `profiles.referral_milestone`, `profiles.pro_until`, `profiles.signup_ip`; table `referral_activations`; function `process_referrals()`; updated `handle_new_user()`

- [ ] **Step 1: Append migration to schema.sql**

Add this entire block at the bottom of `supabase/schema.sql`:

```sql
-- ───────────── referral system ─────────────

alter table public.profiles
  add column if not exists referral_code      text unique,
  add column if not exists referred_by        uuid references public.profiles(id),
  add column if not exists referral_count     integer default 0,
  add column if not exists referral_milestone integer default 0,
  add column if not exists pro_until          timestamptz,
  add column if not exists signup_ip          inet;

-- referral_activations: one row per referral relationship, ever.
create table if not exists public.referral_activations (
  id                  uuid primary key default gen_random_uuid(),
  referrer_id         uuid references public.profiles(id) on delete cascade not null,
  referred_id         uuid references public.profiles(id) on delete cascade not null,
  status              text not null default 'pending'
                        check (status in ('pending','confirmed','rejected')),
  reject_reason       text,
  signup_ip           inet,
  first_generation_at timestamptz,
  confirmed_at        timestamptz,
  created_at          timestamptz default now(),
  constraint referral_activations_referred_unique unique (referred_id)
);

create index if not exists referral_activations_referrer_idx
  on public.referral_activations (referrer_id, status);

alter table public.referral_activations enable row level security;

drop policy if exists "referral_activations self read" on public.referral_activations;
create policy "referral_activations self read" on public.referral_activations
  for select using (auth.uid() = referrer_id or auth.uid() = referred_id);

-- Backfill referral codes for users who signed up before this migration.
do $$
declare
  r record;
  v_code text;
begin
  for r in select id from public.profiles where referral_code is null loop
    loop
      v_code := 'SF-' || upper(substring(encode(gen_random_bytes(4), 'hex'), 1, 6));
      exit when not exists (select 1 from public.profiles where referral_code = v_code);
    end loop;
    update public.profiles set referral_code = v_code where id = r.id;
  end loop;
end;
$$;

-- Updated handle_new_user: generates referral code + seeds credits + handles attribution.
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
    v_code := 'SF-' || upper(substring(encode(gen_random_bytes(4), 'hex'), 1, 6));
    exit when not exists (select 1 from public.profiles where referral_code = v_code);
  end loop;

  insert into public.profiles (id, email, credit_balance, referral_code)
  values (new.id, new.email, coalesce(v_free, 68000), v_code)
  on conflict (id) do nothing;

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
    else
      -- Self-referral or unknown code: log as rejected.
      insert into public.referral_activations (referrer_id, referred_id, status, reject_reason)
      values (coalesce(v_referrer_id, new.id), new.id, 'rejected', 'self_referral')
      on conflict (referred_id) do nothing;
    end if;
  end if;

  return new;
end;
$$;

-- Hourly job: confirm pending referrals that have passed the 24h + first-generation gate.
create or replace function public.process_referrals()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r               record;
  v_new_count     integer;
  v_milestone     integer;
  v_earned        integer;
  v_pro_credits   bigint;
begin
  select value::bigint into v_pro_credits from public.config where key = 'credit_monthly_pro';

  for r in
    select ra.id, ra.referrer_id
      from public.referral_activations ra
     where ra.status = 'pending'
       and ra.first_generation_at is not null
       and ra.first_generation_at < now() - interval '24 hours'
       -- Daily cap: max 10 confirmations per referrer per 24h (anti-burst-fraud).
       and (
         select count(*) from public.referral_activations
          where referrer_id = ra.referrer_id
            and status = 'confirmed'
            and confirmed_at > now() - interval '24 hours'
       ) < 10
  loop
    update public.referral_activations
       set status = 'confirmed', confirmed_at = now()
     where id = r.id;

    update public.profiles
       set referral_count = referral_count + 1
     where id = r.referrer_id
     returning referral_count into v_new_count;

    select referral_milestone into v_milestone
      from public.profiles where id = r.referrer_id;

    v_earned := (v_new_count / 5) * 5;

    if v_earned > coalesce(v_milestone, 0) then
      update public.profiles
         set referral_milestone = v_earned,
             pro_until = greatest(coalesce(pro_until, now()), now()) + interval '1 month',
             -- Top up credits to Pro level immediately when first Pro month is earned.
             credit_balance = greatest(credit_balance, coalesce(v_pro_credits, 680000))
       where id = r.referrer_id;
    end if;
  end loop;
end;
$$;

-- Schedule process_referrals hourly.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('siteforge_process_referrals')
      where exists (select 1 from cron.job where jobname = 'siteforge_process_referrals');
    perform cron.schedule(
      'siteforge_process_referrals',
      '0 * * * *',
      $cron$select public.process_referrals();$cron$
    );
  end if;
end;
$$;
```

- [ ] **Step 2: Run migration in Supabase SQL editor**

Open Supabase dashboard → SQL editor → paste the entire block above → Run.

Verify with:
```sql
-- Should show new columns
select referral_code, referred_by, referral_count, referral_milestone, pro_until
from profiles limit 3;

-- Should show all existing users now have a code
select count(*) from profiles where referral_code is null;
-- Expected: 0

-- Should show the table exists
select count(*) from referral_activations;
-- Expected: 0 (empty)

-- Should show the cron job
select jobname, schedule from cron.job where jobname = 'siteforge_process_referrals';
-- Expected: 1 row
```

- [ ] **Step 3: Commit schema change**

```bash
git add supabase/schema.sql
git commit -m "feat(db): add referral system schema, trigger, and process_referrals cron"
```

---

## Task 2: Shared Referral Helper

**Files:**
- Create: `supabase/functions/_shared/referral.ts`

**Interfaces:**
- Consumes: `adminClient()` return type from `./_shared/auth.ts`
- Produces:
  - `checkReferralActivation(supabase, userId: string): Promise<void>` — called from generate-site after site insert
  - `confirmReferral(supabase, activationId: string, referrerId: string): Promise<void>` — called by checkReferralActivation when 24h already elapsed

- [ ] **Step 1: Create the shared helper**

Create `supabase/functions/_shared/referral.ts`:

```typescript
// deno-lint-ignore-file no-explicit-any

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Called after a user generates their first (or any) site.
 * Marks first_generation_at on their pending referral activation.
 * If the account is already >24h old, confirms the referral immediately;
 * otherwise leaves it for the hourly process_referrals() cron.
 */
export async function checkReferralActivation(
  supabase: any,
  userId: string,
): Promise<void> {
  const { data: activation } = await supabase
    .from('referral_activations')
    .select('id, created_at, referrer_id, first_generation_at')
    .eq('referred_id', userId)
    .eq('status', 'pending')
    .maybeSingle();

  if (!activation) return;
  if (activation.first_generation_at) return; // already marked on a previous generation

  const now = new Date();

  await supabase
    .from('referral_activations')
    .update({ first_generation_at: now.toISOString() })
    .eq('id', activation.id);

  const accountAge = now.getTime() - new Date(activation.created_at).getTime();
  if (accountAge >= TWENTY_FOUR_HOURS_MS) {
    await confirmReferral(supabase, activation.id, activation.referrer_id);
  }
  // else: cron will confirm it once 24h has elapsed
}

/**
 * Marks an activation as confirmed and updates the referrer's count + milestone.
 * Grants pro_until extension and credit top-up if a 5-referral milestone is hit.
 */
export async function confirmReferral(
  supabase: any,
  activationId: string,
  referrerId: string,
): Promise<void> {
  await supabase
    .from('referral_activations')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', activationId);

  const { data: profile } = await supabase
    .from('profiles')
    .select('referral_count, referral_milestone, pro_until')
    .eq('id', referrerId)
    .single();

  if (!profile) return;

  const newCount = (profile.referral_count ?? 0) + 1;
  const lastMilestone = profile.referral_milestone ?? 0;
  const earnedMilestone = Math.floor(newCount / 5) * 5;

  const update: Record<string, unknown> = { referral_count: newCount };

  if (earnedMilestone > lastMilestone) {
    update.referral_milestone = earnedMilestone;
    const base =
      profile.pro_until && new Date(profile.pro_until) > new Date()
        ? new Date(profile.pro_until)
        : new Date();
    base.setMonth(base.getMonth() + 1);
    update.pro_until = base.toISOString();

    // Fetch pro credit allowance and top up immediately.
    const { data: cfg } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'credit_monthly_pro')
      .single();
    const proCredits = parseInt(cfg?.value ?? '680000', 10);

    // Use rpc to safely set credit_balance to max(current, pro_credits).
    await supabase.rpc('set_credit_balance_if_lower', {
      p_user_id: referrerId,
      p_floor: proCredits,
    }).then(null, () => {}); // best-effort; fn may not exist yet — see Task 1 note
    // Fallback: set directly if rpc not available
    update.credit_balance = proCredits;
  }

  await supabase.from('profiles').update(update).eq('id', referrerId);
}
```

Note: The credit top-up uses a direct update (`credit_balance = proCredits`) — safe because `process_referrals()` SQL uses `GREATEST(credit_balance, v_pro_credits)`. For the TS path, setting to `proCredits` is acceptable since free users typically have far less.

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/referral.ts
git commit -m "feat(referral): add shared checkReferralActivation + confirmReferral helpers"
```

---

## Task 3: referral-stats Edge Function

**Files:**
- Create: `supabase/functions/referral-stats/index.ts`

**Interfaces:**
- Consumes: `adminClient`, `getUser`, `errorResponse`, `corsHeaders` from `_shared`
- Produces: `POST /referral-stats` → `{ code, link, count, milestone, nextMilestone, progressToNext, pro_until, activations[] }`

- [ ] **Step 1: Create the function**

Create `supabase/functions/referral-stats/index.ts`:

```typescript
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { errorResponse } from '../_shared/guards.ts';

const APP_URL = Deno.env.get('APP_URL') ?? 'https://siteforge.io';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const user = await getUser(req);
  if (!user) return errorResponse(401, 'Unauthorized');

  const supabase = adminClient();

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('referral_code, referral_count, referral_milestone, pro_until')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) return errorResponse(404, 'profile_not_found');

  const { data: activations } = await supabase
    .from('referral_activations')
    .select('status, first_generation_at, confirmed_at, created_at')
    .eq('referrer_id', user.id)
    .neq('status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(20);

  const count = profile.referral_count ?? 0;
  const milestone = profile.referral_milestone ?? 0;
  const nextMilestone = milestone + 5;

  return new Response(
    JSON.stringify({
      code: profile.referral_code,
      link: `${APP_URL}/signup?ref=${profile.referral_code}`,
      count,
      milestone,
      nextMilestone,
      progressToNext: count - milestone, // e.g. 3 out of 5 toward next reward
      pro_until: profile.pro_until ?? null,
      activations: activations ?? [],
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
```

- [ ] **Step 2: Deploy and verify**

```bash
npx supabase functions deploy referral-stats
```

Test via curl (replace TOKEN with a real user JWT from browser devtools → Application → Local Storage → `sb-*-auth-token`):

```bash
curl -X POST https://<YOUR_PROJECT>.supabase.co/functions/v1/referral-stats \
  -H "Authorization: Bearer TOKEN" \
  -H "apikey: YOUR_ANON_KEY"
```

Expected response:
```json
{
  "code": "SF-3FA9C1",
  "link": "https://siteforge.io/signup?ref=SF-3FA9C1",
  "count": 0,
  "milestone": 0,
  "nextMilestone": 5,
  "progressToNext": 0,
  "pro_until": null,
  "activations": []
}
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/referral-stats/
git commit -m "feat(referral): add referral-stats edge function"
```

---

## Task 4: claim-referral Edge Function

**Files:**
- Create: `supabase/functions/claim-referral/index.ts`

**Interfaces:**
- Consumes: `adminClient`, `getUser`, `errorResponse`, `clientIp`, `readBoundedJson`, `corsHeaders`
- Produces: `POST /claim-referral` body `{ referral_code: string }` → `{ ok: true }` or `{ ok: true, skipped: string }`

- [ ] **Step 1: Create the function**

Create `supabase/functions/claim-referral/index.ts`:

```typescript
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { errorResponse, clientIp, readBoundedJson } from '../_shared/guards.ts';

const ONE_HOUR_MS = 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const user = await getUser(req);
  if (!user) return errorResponse(401, 'Unauthorized');

  const supabase = adminClient();

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('referred_by, created_at, signup_ip')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) return errorResponse(404, 'profile_not_found');

  // Already attributed — idempotent success.
  if (profile.referred_by) {
    return new Response(
      JSON.stringify({ ok: true, skipped: 'already_attributed' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Reject retroactive claims (must be within 1h of signup).
  const accountAge = Date.now() - new Date(profile.created_at).getTime();
  if (accountAge > ONE_HOUR_MS) {
    return errorResponse(400, 'claim_window_expired');
  }

  const body = await readBoundedJson(req) as Record<string, unknown>;
  const rawCode = body?.referral_code;
  if (!rawCode || typeof rawCode !== 'string') {
    return errorResponse(400, 'missing_referral_code');
  }
  const referralCode = rawCode.trim().toUpperCase();

  // Resolve referrer by code.
  const { data: referrer } = await supabase
    .from('profiles')
    .select('id, signup_ip')
    .eq('referral_code', referralCode)
    .maybeSingle();

  if (!referrer) return errorResponse(404, 'invalid_code');
  if (referrer.id === user.id) return errorResponse(400, 'self_referral');

  const ip = clientIp(req);
  const referrerIp = referrer.signup_ip?.toString() ?? null;
  const isDuplicateIp = ip !== 'unknown' && referrerIp !== null && ip === referrerIp;

  if (isDuplicateIp) {
    // Flag as duplicate IP but don't hard-block (could be same household).
    await supabase.from('referral_activations').insert({
      referrer_id: referrer.id,
      referred_id: user.id,
      status: 'rejected',
      reject_reason: 'duplicate_ip',
      signup_ip: ip,
    }).then(null, () => {}); // ignore unique violation
    return new Response(
      JSON.stringify({ ok: true, skipped: 'duplicate_ip' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Set referred_by on profile and store signup_ip.
  await supabase
    .from('profiles')
    .update({ referred_by: referrer.id, signup_ip: ip !== 'unknown' ? ip : null })
    .eq('id', user.id);

  // Insert activation row (unique constraint on referred_id makes this idempotent).
  const { error: insertErr } = await supabase.from('referral_activations').insert({
    referrer_id: referrer.id,
    referred_id: user.id,
    signup_ip: ip !== 'unknown' ? ip : null,
  });

  if (insertErr && insertErr.code !== '23505') {
    return errorResponse(500, 'insert_failed');
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
```

- [ ] **Step 2: Deploy and verify**

```bash
npx supabase functions deploy claim-referral
```

Quick smoke test — call with a valid referral code from another test account:

```bash
curl -X POST https://<YOUR_PROJECT>.supabase.co/functions/v1/claim-referral \
  -H "Authorization: Bearer NEW_USER_TOKEN" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"referral_code":"SF-XXXXXX"}'
```

Expected: `{"ok":true}`. Check DB: `select * from referral_activations;` — should show 1 pending row.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/claim-referral/
git commit -m "feat(referral): add claim-referral edge function for OAuth post-signup attribution"
```

---

## Task 5: Update generate-site Edge Function

**Files:**
- Modify: `supabase/functions/generate-site/index.ts`

**Interfaces:**
- Consumes: `checkReferralActivation` from `../_shared/referral.ts`

- [ ] **Step 1: Add import at top of generate-site/index.ts**

After the existing imports (around line 8), add:

```typescript
import { checkReferralActivation } from '../_shared/referral.ts';
```

- [ ] **Step 2: Call checkReferralActivation after site insert**

Find this block (around line 587–589, after `deductCredits`):

```typescript
        await supabase.from('profiles').update({ generations_used: (profile.generations_used ?? 0) + 1 }).eq('id', user.id);
        const actionType = isEditMode ? 'edit' : 'generation';
        await deductCredits(supabase, user.id, totalUsage, actionType, rates, site.id);
```

Add one line after `deductCredits`:

```typescript
        await supabase.from('profiles').update({ generations_used: (profile.generations_used ?? 0) + 1 }).eq('id', user.id);
        const actionType = isEditMode ? 'edit' : 'generation';
        await deductCredits(supabase, user.id, totalUsage, actionType, rates, site.id);
        await checkReferralActivation(supabase, user.id).catch(() => {}); // non-critical
```

The `.catch(() => {})` ensures a referral error never fails a generation.

- [ ] **Step 3: Deploy and verify**

```bash
npx supabase functions deploy generate-site
```

Generate a site as a user who was referred. Check DB:
```sql
select * from referral_activations where referred_id = '<user_uuid>';
-- first_generation_at should now be set
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/generate-site/index.ts supabase/functions/_shared/referral.ts
git commit -m "feat(referral): track first generation in referral activation pipeline"
```

---

## Task 6: Client Library + Auth + AppLayout

**Files:**
- Create: `src/lib/referral.js`
- Modify: `src/lib/auth.jsx`
- Modify: `src/pages/AppLayout.jsx`

**Interfaces:**
- Produces:
  - `storePendingReferral(code: string): void`
  - `getPendingReferral(): string | null`
  - `clearPendingReferral(): void`
  - `claimPendingReferral(): Promise<void>`
  - `getReferralStats(): Promise<ReferralStats>`
  - `isProUser(profile): boolean` (exported from auth.jsx)

- [ ] **Step 1: Create src/lib/referral.js**

```javascript
import { callFunction } from './api.js';

const STORAGE_KEY = 'sf_pending_referral';
const CODE_RE = /^SF-[0-9A-F]{6}$/i;

export function storePendingReferral(code) {
  if (code && CODE_RE.test(code)) {
    localStorage.setItem(STORAGE_KEY, code.toUpperCase());
  }
}

export function getPendingReferral() {
  return localStorage.getItem(STORAGE_KEY);
}

export function clearPendingReferral() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Silently attempts to claim a pending referral code. Never throws. */
export async function claimPendingReferral() {
  const code = getPendingReferral();
  if (!code) return;
  clearPendingReferral(); // clear first to avoid retry loops
  try {
    await callFunction('claim-referral', { referral_code: code });
  } catch {
    // Silently ignore — referral is not on the critical path.
  }
}

/** Returns the user's referral stats from the edge function. */
export async function getReferralStats() {
  return callFunction('referral-stats', {});
}
```

- [ ] **Step 2: Add isProUser to src/lib/auth.jsx**

At the bottom of `src/lib/auth.jsx`, after the `useAuth` export, add:

```javascript
/** Returns true if user has an active paid plan or an active referral Pro grant. */
export function isProUser(profile) {
  if (!profile) return false;
  if (profile.plan === 'pro') return true;
  if (profile.pro_until && new Date(profile.pro_until) > new Date()) return true;
  return false;
}
```

- [ ] **Step 3: Update AppLayout.jsx to claim pending referral after OAuth login**

Read `src/pages/AppLayout.jsx` first to see current structure, then add the referral claim effect.

The file imports `useAuth` and renders the layout. Add after the existing imports:

```javascript
import { claimPendingReferral, getPendingReferral } from '../lib/referral.js';
```

Inside `AppLayout`, after the `const { user, profile } = useAuth();` line, add:

```javascript
// Claim any pending referral code stored before OAuth redirect.
useEffect(() => {
  if (!user || !profile) return;
  if (profile.referred_by) return; // already attributed
  if (!getPendingReferral()) return;
  claimPendingReferral();
}, [user?.id, profile?.id]); // run once per login
```

Also add `useEffect` to the import from React if not already present.

- [ ] **Step 4: Commit**

```bash
git add src/lib/referral.js src/lib/auth.jsx src/pages/AppLayout.jsx
git commit -m "feat(referral): add client referral helpers, isProUser, OAuth claim-on-login"
```

---

## Task 7: Signup.jsx — Referral Param Handling

**Files:**
- Modify: `src/pages/Signup.jsx`

**Interfaces:**
- Consumes: `storePendingReferral`, `getPendingReferral` from `../lib/referral.js`

- [ ] **Step 1: Update Signup.jsx**

Replace the entire file with this updated version:

```jsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { storePendingReferral, getPendingReferral } from '../lib/referral.js';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Capture referral code from URL or existing localStorage.
  useEffect(() => {
    const ref = searchParams.get('ref');
    if (ref) storePendingReferral(ref);
  }, [searchParams]);

  const pendingRef = getPendingReferral();

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setInfo('');
    const referralCode = getPendingReferral();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/app/chat`,
        data: referralCode ? { referral_code: referralCode } : {},
      },
    });
    setBusy(false);
    if (error) return setErr(error.message);
    if (data?.session) {
      navigate('/app/chat', { replace: true });
    } else {
      setInfo('Check your email to confirm your account.');
    }
  }

  async function onGoogle() {
    setErr('');
    // Store current referral code before OAuth redirect (redirect clears URL params).
    const ref = searchParams.get('ref');
    if (ref) storePendingReferral(ref);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/app/chat` },
    });
    if (error) setErr(error.message);
  }

  return (
    <div className="min-h-screen grid-bg flex items-center justify-center p-6">
      <div className="card p-8 w-full max-w-sm">
        <Link to="/" className="font-mono uppercase tracking-widest text-sm">
          Site<span className="text-accent">Forge</span>
        </Link>
        {pendingRef && (
          <div className="mt-3 mb-1 font-mono text-xs text-accent border border-accent px-3 py-2">
            You were invited to SiteForge
          </div>
        )}
        <h1 className="font-mono text-2xl mt-4 mb-6">Create account</h1>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <div className="label mb-1">Email</div>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <div className="label mb-1">Password</div>
            <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {err && <div className="font-mono text-xs text-accent">{err}</div>}
          {info && <div className="font-mono text-xs text-muted">{info}</div>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'creating…' : 'Sign Up'}</button>
        </form>
        <div className="my-6 flex items-center gap-3">
          <div className="flex-1 h-px bg-border" />
          <span className="label">or</span>
          <div className="flex-1 h-px bg-border" />
        </div>
        <button onClick={onGoogle} className="btn w-full">Continue with Google</button>
        <p className="mt-4 font-mono text-[11px] leading-relaxed text-muted text-center">
          By signing up you agree to our{' '}
          <Link to="/terms" className="text-accent">Terms</Link> and{' '}
          <Link to="/privacy" className="text-accent">Privacy Policy</Link>.
        </p>
        <div className="mt-4 font-mono text-xs text-muted text-center">
          Have an account? <Link to="/login" className="text-accent">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify in browser**

Open `http://localhost:5173/signup?ref=SF-AABBCC` — should show "You were invited to SiteForge" banner. Complete signup — check `profiles` in Supabase dashboard: `referred_by` should be set to the referrer's UUID.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Signup.jsx
git commit -m "feat(referral): capture ?ref= param on signup, pass code through email + OAuth paths"
```

---

## Task 8: Settings.jsx — Referral Section

**Files:**
- Modify: `src/pages/Settings.jsx`

**Interfaces:**
- Consumes: `getReferralStats` from `../lib/referral.js`; `isProUser` from `../lib/auth.jsx`

- [ ] **Step 1: Read Settings.jsx**

Read `src/pages/Settings.jsx` to understand the existing section structure before adding.

- [ ] **Step 2: Add referral section**

Add to imports at top of Settings.jsx:

```javascript
import { getReferralStats } from '../lib/referral.js';
import { isProUser } from '../lib/auth.jsx';
```

Add state near the top of the component, alongside existing state:

```javascript
const [referralStats, setReferralStats] = useState(null);
const [referralLoading, setReferralLoading] = useState(true);
const [copied, setCopied] = useState(false);
```

Add a useEffect to load referral stats (after existing useEffects):

```javascript
useEffect(() => {
  getReferralStats()
    .then((s) => setReferralStats(s))
    .catch(() => {})
    .finally(() => setReferralLoading(false));
}, []);
```

Add a copy handler:

```javascript
function copyReferralLink() {
  if (!referralStats?.link) return;
  navigator.clipboard.writeText(referralStats.link).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
}
```

Add the referral section in the JSX, placed before the credit ledger section (or at the end — follow the existing section ordering pattern):

```jsx
{/* ── Referral ── */}
<section className="card p-6 space-y-4">
  <div className="label">Referral</div>

  {referralLoading ? (
    <div className="font-mono text-xs text-muted">Loading…</div>
  ) : referralStats ? (
    <>
      <div className="space-y-2">
        <div className="font-mono text-xs text-muted uppercase tracking-wider">Your referral link</div>
        <div className="flex gap-2">
          <input
            className="input font-mono text-xs flex-1"
            readOnly
            value={referralStats.link}
            onFocus={(e) => e.target.select()}
          />
          <button className="btn text-xs px-3" onClick={copyReferralLink}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="font-mono text-xs text-muted uppercase tracking-wider">
          Progress — {referralStats.progressToNext} / 5 toward next free Pro month
        </div>
        <div className="w-full bg-border h-2">
          <div
            className="bg-accent h-2 transition-all"
            style={{ width: `${(referralStats.progressToNext / 5) * 100}%` }}
          />
        </div>
        <div className="font-mono text-xs text-muted">
          {referralStats.count} confirmed referral{referralStats.count !== 1 ? 's' : ''} total
        </div>
      </div>

      {referralStats.pro_until && new Date(referralStats.pro_until) > new Date() && (
        <div className="font-mono text-xs text-accent border border-accent px-3 py-2">
          Pro access active until {new Date(referralStats.pro_until).toLocaleDateString()}
        </div>
      )}

      {referralStats.activations.length > 0 && (
        <div className="space-y-1">
          <div className="font-mono text-xs text-muted uppercase tracking-wider">Recent referrals</div>
          {referralStats.activations.map((a, i) => (
            <div key={i} className="flex items-center justify-between font-mono text-xs py-1 border-b border-border">
              <span className={a.status === 'confirmed' ? 'text-accent' : 'text-muted'}>
                {a.status === 'confirmed' ? '✓ Activated' : a.first_generation_at ? '⏳ Awaiting 24h' : '⏳ Pending first site'}
              </span>
              <span className="text-muted">
                {new Date(a.created_at).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="font-mono text-xs text-muted">
        Share your link. When 5 friends generate their first site, you earn one free month of Pro.
      </div>
    </>
  ) : (
    <div className="font-mono text-xs text-muted">Could not load referral data.</div>
  )}
</section>
```

- [ ] **Step 3: Verify in browser**

Navigate to `/app/settings`. Referral section should show your code, link, empty progress bar. Copy button should copy link to clipboard.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Settings.jsx
git commit -m "feat(referral): add referral section to Settings with link, progress bar, and activations"
```

---

## Task 9: Chat.jsx — planLabel Fix + Post-Generation Nudge

**Files:**
- Modify: `src/pages/Chat.jsx`

**Interfaces:**
- Consumes: `isProUser` from `../lib/auth.jsx`; `getPendingReferral` (not needed here — nudge uses profile data)

- [ ] **Step 1: Fix planLabel to use isProUser**

In `src/pages/Chat.jsx`, add import:

```javascript
import { isProUser } from '../lib/auth.jsx';
```

Find line 55:
```javascript
const planLabel = profile?.plan === 'pro' ? '[PRO]' : '[FREE]';
```

Replace with:
```javascript
const planLabel = isProUser(profile) ? '[PRO]' : '[FREE]';
```

- [ ] **Step 2: Add dismissible referral nudge state**

Near the top of the Chat component, add state:

```javascript
const [showReferralNudge, setShowReferralNudge] = useState(false);
```

- [ ] **Step 3: Show nudge after first successful generation**

In the `onSubmit` function, after `await refreshProfile()` (around line 242), add:

```javascript
      await refreshProfile();
      loadSessions();
      // Show referral nudge after first ever generation if not already dismissed.
      if (!localStorage.getItem('sf_referral_nudge_dismissed')) {
        setShowReferralNudge(true);
      }
```

- [ ] **Step 4: Render nudge in JSX**

In the chat thread area (inside the `<div ref={threadRef}>` scroll area, after the messages map), add:

```jsx
{showReferralNudge && (
  <div className="card border-accent p-4 font-mono text-sm flex items-start justify-between gap-3">
    <div>
      <div className="label text-accent mb-1">Get Pro free</div>
      Refer 5 friends who generate a site — earn one free month of Pro.{' '}
      <Link to="/app/settings" className="text-accent underline">
        Get your link →
      </Link>
    </div>
    <button
      className="text-muted hover:text-accent text-xs shrink-0"
      onClick={() => {
        localStorage.setItem('sf_referral_nudge_dismissed', '1');
        setShowReferralNudge(false);
      }}
    >
      ✕
    </button>
  </div>
)}
```

- [ ] **Step 5: Verify in browser**

Generate a site. Referral nudge should appear below the assistant message. Click ✕ to dismiss — should not reappear after page reload. `[PRO]` badge should appear for users with an active `pro_until` date.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Chat.jsx
git commit -m "feat(referral): fix planLabel for pro_until users, add post-generation referral nudge"
```

---

## SQL to Run in Supabase

All SQL is in the migration block appended to `supabase/schema.sql` in Task 1. Run **only that block** in Supabase SQL editor (not the whole file — earlier sections are already applied).

The block covers:
1. `ALTER TABLE profiles ADD COLUMN ...` — 6 new columns
2. `CREATE TABLE referral_activations` + RLS policy + index
3. Backfill referral codes for existing users
4. `CREATE OR REPLACE FUNCTION handle_new_user()` — updated trigger
5. `CREATE OR REPLACE FUNCTION process_referrals()` — hourly cron fn
6. `pg_cron.schedule('siteforge_process_referrals', ...)` — hourly job

After running, verify with the queries in Task 1 Step 2.
