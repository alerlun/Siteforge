# Supabase configuration — SiteForge

This file documents the manual Supabase Dashboard settings required by the security-hardening pass. Everything that can live in code is in `supabase/functions/`; the items below cannot be set from the CLI and must be applied in the dashboard.

## 1. Edge Function secrets

Set with `supabase secrets set KEY=value` (or via Dashboard → Edge Functions → Secrets). Required keys:

| Key | Purpose |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB admin client |
| `STRIPE_SECRET_KEY_LIVE` | Stripe API (live mode — required when `config.stripe_mode = 'live'`) |
| `STRIPE_SECRET_KEY_TEST` | Stripe API (test mode) |
| `STRIPE_WEBHOOK_SECRET_LIVE` | Live webhook signature verification |
| `STRIPE_WEBHOOK_SECRET_TEST` | Test webhook signature |
| `STRIPE_PRO_PRICE_ID_LIVE` / `STRIPE_PRO_PRICE_ID_TEST` | Pro plan price IDs per mode |
| `ANTHROPIC_API_KEY` | Claude API for `generate-site` |
| `ANTHROPIC_MODEL` | (optional) override the default Claude model |
| `GOOGLE_PLACES_API_KEY` | Places search for `scrape-leads` |

Rate limiting is **Postgres-backed** (Supabase) and needs no secrets — see `schema.sql`
(`rate_limits` table + `check_rate_limit()` function). Just apply `schema.sql`.

**Never** put any of these in a Vite `VITE_*` variable — those reach the browser bundle.

The Google Places key should also be **restricted in the Google Cloud Console** to the Places API and to the Supabase Edge Function egress IPs (or to none, since these are server-only calls).

## 2. Auth → Rate Limits (Dashboard → Authentication → Rate Limits)

The "5 attempts per 15 minutes on auth routes" requirement is enforced by Supabase, since login/signup/reset flows talk to Supabase Auth directly from the browser.

| Setting | Value | Notes |
|---|---|---|
| Sign-in attempts | **5 per 15 minutes per IP** | Maps to "Rate limit for token verifications" — set to 5 / 900s |
| Sign-up attempts | **5 per 15 minutes per IP** | Limits new account creation from one IP |
| Email send rate | **3 per hour** | Magic links, password reset, confirmations |
| Token refresh | **150 per 5 minutes** | Default is fine; lower only if abuse is observed |
| MFA challenges | **5 per 5 minutes** | Default |
| Anonymous sign-ins | **Off** unless feature is in use | Reduces abuse surface |

If a knob isn't exposed at that exact value, pick the closest stricter one — never looser.

## 3. Auth → URL configuration

- **Site URL**: production origin only (e.g. `https://siteforge.app`).
- **Additional redirect URLs**: list every preview / staging origin explicitly. Do **not** wildcard the whole domain (`https://*.vercel.app` accepts subdomain takeovers).
- **JWT expiry**: 3600s (1h) is the default — keep, do not extend.

## 4. Database

- **RLS** must be enabled on every table that holds user data (`profiles`, `leads`, `chat_sessions`, `generated_sites`, `chat_messages`). Confirm before going live; the schema in `schema.sql` is the source of truth.
- The service role key in `_shared/auth.ts` bypasses RLS — only used inside Edge Functions, never shipped to the client.

## 5. Webhooks

Stripe webhook is registered at `<project>.functions.supabase.co/stripe-webhook`. `verify_jwt = false` is correct (Stripe doesn't send a JWT); the function verifies signatures with `STRIPE_WEBHOOK_SECRET`.

## 6. Local development

`.env`, `.env.live`, `.env.test` are gitignored. After the secret rotation step in `SECURITY_AUDIT.md`, those files hold the rotated keys for local Vite dev only. Edge Functions in production read from Supabase secrets, not from these files.
