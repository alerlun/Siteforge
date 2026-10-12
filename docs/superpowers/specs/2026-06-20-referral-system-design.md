# SiteForge — Viral Referral System Design

**Date:** 2026-06-20  
**Status:** Approved  
**Approach:** Sync + Cron hybrid (Approach A)

## Context

SiteForge needs a viral referral loop to drive user growth. Every user automatically gets a referral code and link. When a referred user signs up and generates their first site (and has held their account for 24 hours), the referrer's confirmed referral count increments. Every 5 confirmed referrals earns the referrer one free month of Pro access via a temporary `pro_until` date — no Stripe involvement. The chain is indefinite: referred users immediately become referrers themselves.

---

## 1. Database Schema

### Additions to `profiles`

```sql
alter table public.profiles
  add column if not exists referral_code    text unique,
  add column if not exists referred_by      uuid references public.profiles(id),
  add column if not exists referral_count   integer default 0,
  add column if not exists referral_milestone integer default 0,
  add column if not exists pro_until        timestamptz,
  add column if not exists signup_ip        inet;
```

| Column | Notes |
|---|---|
| `referral_code` | `SF-` + 6 hex chars, e.g. `SF-3FA9C1`. Generated at signup. |
| `referred_by` | Set once, never changed. Enforced by trigger logic (`referred_by IS NULL` check). |
| `referral_count` | Count of confirmed (activated) referrals made by this user. |
| `referral_milestone` | Last rewarded milestone (0, 5, 10, 15…). Prevents double-rewarding. |
| `pro_until` | Null = no temp Pro. Non-null = Pro access until this date. Stackable. |
| `signup_ip` | Stored at signup for duplicate-IP fraud detection. |

### New table `referral_activations`

```sql
create table if not exists public.referral_activations (
  id                   uuid primary key default gen_random_uuid(),
  referrer_id          uuid references public.profiles(id) on delete cascade not null,
  referred_id          uuid references public.profiles(id) on delete cascade not null,
  status               text not null default 'pending'
                         check (status in ('pending','confirmed','rejected')),
  reject_reason        text,           -- 'self_referral' | 'duplicate_ip' | 'expired_claim'
  signup_ip            inet,           -- referred user's IP at attribution time
  first_generation_at  timestamptz,   -- when referred user generated their first site
  confirmed_at         timestamptz,
  created_at           timestamptz default now(),
  constraint referral_activations_referred_unique unique (referred_id)
);

create index if not exists referral_activations_referrer_idx
  on public.referral_activations (referrer_id, status);
```

`referred_id UNIQUE` enforces "one referral per user, ever" at the database level — no application code can bypass it.

### RLS

```sql
alter table public.referral_activations enable row level security;

-- Referrers see their own outbound referrals; referred users see their own record.
create policy "referral_activations self read" on public.referral_activations
  for select using (auth.uid() = referrer_id or auth.uid() = referred_id);
```

---

## 2. Referral Code Generation

Generated inside `handle_new_user()` trigger using pgcrypto:

```sql
loop
  v_code := 'SF-' || upper(substring(encode(gen_random_bytes(4), 'hex'), 1, 6));
  exit when not exists (select 1 from public.profiles where referral_code = v_code);
end loop;
```

16^6 = ~16.7M combinations. Collision probability negligible; loop exits on first try in practice.

---

## 3. Signup + Attribution Flow

### Email signup

1. User visits `/signup?ref=SF-3FA9C1` → `Signup.jsx` reads param, stores in `localStorage('pendingReferral')`, shows "You were invited" banner.
2. `supabase.auth.signUp({ options: { data: { referral_code: 'SF-3FA9C1' } } })` — code travels in `raw_user_meta_data`.
3. `handle_new_user()` trigger fires:
   - Generates `referral_code` for new user.
   - Reads `new.raw_user_meta_data->>'referral_code'`.
   - Resolves referrer: `SELECT id FROM profiles WHERE referral_code = $code`.
   - Validates: referrer exists AND referrer ≠ new user → inserts `referral_activations` row (status=pending) AND sets `profiles.referred_by`.
   - On self-referral or unknown code: insert `referral_activations` with `status='rejected'`, `reject_reason='self_referral'`. Profile created normally.
4. `localStorage('pendingReferral')` cleared on landing at `/app/chat`.

### Google OAuth signup

OAuth redirects lose query params. Attribution happens post-login:

1. Before redirect: `localStorage('pendingReferral') = 'SF-3FA9C1'`.
2. After OAuth lands at `/app/chat`: `auth.jsx` checks `localStorage('pendingReferral')`.
3. If present and user profile has `referred_by IS NULL`: calls `POST /claim-referral` with `{ referral_code }`.
4. `claim-referral` edge function:
   - Verifies account age < 1 hour (`profiles.created_at > now() - interval '1 hour'`) — rejects retroactive claims.
   - Validates referrer exists and is not self.
   - Inserts `referral_activations` (idempotent due to `referred_id UNIQUE`) and sets `referred_by`.
5. `localStorage('pendingReferral')` cleared after call (success or failure).

### Immutability

`referred_by` is set once via trigger or `claim-referral`. Both paths check `profiles.referred_by IS NULL` before writing. Existing users cannot claim a code later — `claim-referral` rejects if `referred_by` already set or account > 1h old.

---

## 4. Activation + Reward Logic

### At first site generation

Added to `generate-site` edge function after the site row is successfully inserted:

```ts
await checkReferralActivation(supabase, user.id);
```

```ts
async function checkReferralActivation(supabase, userId) {
  const { data: activation } = await supabase
    .from('referral_activations')
    .select('id, created_at, first_generation_at, referrer_id')
    .eq('referred_id', userId)
    .eq('status', 'pending')
    .single();

  if (!activation || activation.first_generation_at) return; // already marked

  await supabase.from('referral_activations')
    .update({ first_generation_at: new Date().toISOString() })
    .eq('id', activation.id);

  const accountAge = Date.now() - new Date(activation.created_at).getTime();
  if (accountAge >= 24 * 60 * 60 * 1000) {
    await confirmReferral(supabase, activation.id, activation.referrer_id);
  }
  // else: leave for hourly cron
}
```

### Confirm referral + milestone check

```ts
async function confirmReferral(supabase, activationId, referrerId) {
  await supabase.from('referral_activations')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', activationId);

  // Increment count and check milestone atomically
  const { data: profile } = await supabase
    .from('profiles')
    .select('referral_count, referral_milestone, pro_until')
    .eq('id', referrerId)
    .single();

  const newCount = (profile.referral_count ?? 0) + 1;
  const update: Record<string, unknown> = { referral_count: newCount };

  const lastMilestone = profile.referral_milestone ?? 0;
  const earnedMilestone = Math.floor(newCount / 5) * 5;

  if (earnedMilestone > lastMilestone) {
    update.referral_milestone = earnedMilestone;
    const base = profile.pro_until && new Date(profile.pro_until) > new Date()
      ? new Date(profile.pro_until)
      : new Date();
    base.setMonth(base.getMonth() + 1);
    update.pro_until = base.toISOString();
  }

  await supabase.from('profiles').update(update).eq('id', referrerId);
}
```

### Hourly cron sweep

```sql
create or replace function public.process_referrals()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select id, referrer_id
    from public.referral_activations
    where status = 'pending'
      and first_generation_at is not null
      and first_generation_at < now() - interval '24 hours'
  loop
    -- Confirm the activation
    update public.referral_activations
      set status = 'confirmed', confirmed_at = now()
    where id = r.id;

    -- Increment referrer count and check milestone
    update public.profiles
      set
        referral_count = referral_count + 1,
        referral_milestone = case
          when ((referral_count + 1) / 5) * 5 > referral_milestone
          then ((referral_count + 1) / 5) * 5
          else referral_milestone
        end,
        pro_until = case
          when ((referral_count + 1) % 5 = 0)
            and (((referral_count + 1) / 5) * 5 > referral_milestone)
          then greatest(coalesce(pro_until, now()), now()) + interval '1 month'
          else pro_until
        end
    where id = r.referrer_id;
  end loop;
end;
$$;
```

Schedule hourly via pg_cron:

```sql
perform cron.schedule('siteforge_process_referrals', '0 * * * *',
  $cron$select public.process_referrals();$cron$);
```

### Pro status check in app

Update `auth.jsx` — wherever Pro is checked:

```js
export function isProUser(profile) {
  if (!profile) return false;
  if (profile.plan === 'pro') return true;
  if (profile.pro_until && new Date(profile.pro_until) > new Date()) return true;
  return false;
}
```

---

## 5. Anti-Fraud

| Threat | Defense | Implementation |
|---|---|---|
| Self-referral | Hard reject | Trigger and `claim-referral` both check `referrer_id != referred_id` |
| Duplicate IP | Flag + exclude from rewards | Compare `signup_ip` at attribution; set `reject_reason='duplicate_ip'`, `status='rejected'` |
| Throwaway emails | Activation gate | 24h account age + first generation required before count increments |
| Burst fake-account attacks | Daily cap | `process_referrals()` confirms max 10 activations per referrer per 24h |
| Retroactive OAuth claim | Time window | `claim-referral` rejects if account age > 1h |
| Re-claiming after attribution | DB constraint | `referred_id UNIQUE` + `referred_by IS NULL` check |
| Code enumeration | No public lookup | No unauthenticated endpoint to validate codes |

**Future options:** email domain blocklist for known throwaway providers, FingerprintJS for device fingerprinting, manual review queue for referrers with flagged activations.

---

## 6. Edge Functions

### `referral-stats` (GET, authenticated)

Returns:

```json
{
  "code": "SF-3FA9C1",
  "link": "https://siteforge.io/signup?ref=SF-3FA9C1",
  "count": 3,
  "nextMilestone": 5,
  "pro_until": null,
  "activations": [
    { "status": "confirmed", "confirmed_at": "..." },
    { "status": "pending", "first_generation_at": "..." },
    { "status": "pending", "first_generation_at": null }
  ]
}
```

### `claim-referral` (POST, authenticated)

Body: `{ "referral_code": "SF-3FA9C1" }`

Validates: account < 1h old, referrer exists, not self, `referred_by` not already set. Creates `referral_activations` row, sets `profiles.referred_by`.

---

## 7. Frontend Changes

### `src/pages/Signup.jsx`
- On mount: read `?ref=CODE` from URL → store in `localStorage('pendingReferral')`.
- Show "You were invited to SiteForge" banner when code present.
- Pass code in `signUp` metadata.

### `src/lib/auth.jsx`
- After OAuth login: check `localStorage('pendingReferral')` → call `claim-referral` if profile has no `referred_by`.
- Export `isProUser(profile)` helper.
- `refreshProfile()` already re-fetches — picks up `pro_until` and `referral_count` automatically.

### `src/pages/Settings.jsx` — new Referral section
- Display referral link with copy-to-clipboard button.
- Progress bar: `referral_count % 5` out of 5 toward next Pro month.
- "You have earned X free Pro months" if `pro_until` set.
- List of recent activations (pending / confirmed) from `referral-stats`.
- Pre-written share copy for Twitter/WhatsApp.

### `src/pages/Chat.jsx` — post-generation nudge
- After first successful generation: show one-time dismissible banner — "Share your link, get Pro free when 5 friends join."

---

## 8. Analytics + K-factor

**Metrics to track from `referral_activations`:**
- Signup-with-code rate: signups that had a referral code / total signups
- Activation rate: `confirmed` / total with `first_generation_at` set
- Time-to-activation: `first_generation_at - created_at`
- Top referrers by `referral_count`
- K-factor: average referral invites sent per user × activation rate

**K-factor levers:**
- Post-generation referral nudge (Chat.jsx banner) — shown when motivation is highest
- Referral link in Supabase welcome email template
- Progress notification on each generation: "2 more referrals to your free Pro month"
- Pre-written share messages lower friction vs blank copy-paste

---

## 9. Verification

1. **Email signup**: create account with `?ref=VALID_CODE` → check `profiles.referred_by` set, `referral_activations` row exists with `status=pending`.
2. **OAuth signup**: sign in with Google, check `localStorage` flow triggers `claim-referral`, same DB state as above.
3. **Self-referral**: attempt signup with own code → `referral_activations` row has `status='rejected'`, `reject_reason='self_referral'`.
4. **Activation**: generate first site as referred user → check `first_generation_at` set; if account > 24h old, check `status='confirmed'` and referrer `referral_count` incremented.
5. **Milestone reward**: manufacture 5 confirmed referrals for a test user → check `pro_until` set ~1 month out, `referral_milestone=5`. Run again to reach 10 → `pro_until` extended another month.
6. **Cron**: call `process_referrals()` manually in SQL editor with a pending referral where `first_generation_at < now() - interval '24h'` → confirm it resolves.
7. **isProUser**: set `pro_until = now() + interval '1 day'` on a free user → verify app treats them as Pro.
