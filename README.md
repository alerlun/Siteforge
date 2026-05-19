# SiteForge

Generate websites for local businesses, scrape leads, track sales — in one workspace.

Stack: React + Vite, Tailwind, Supabase (auth + Postgres + Edge Functions), Stripe, OpenAI (`gpt-4o`), Google Places.

---

## Quick start

```bash
npm install
cp .env.example .env   # fill in values (see below)
npm run dev
```

Open http://localhost:5173.

---

## Accounts you need

1. **Supabase** — supabase.com — create a project. Save Project URL, anon key, service_role key (Settings → API).
2. **OpenAI** — platform.openai.com — generate an API key. Load credits. Default model is `gpt-4o` (override with `OPENAI_MODEL`).
3. **Google Cloud** — console.cloud.google.com — enable **Places API** and **Maps JavaScript API**, create an API key.
4. **Stripe** — dashboard.stripe.com — grab test + live publishable/secret keys. Create a Product `SiteForge Pro` priced at $19.99/mo recurring; save the Price ID (starts with `price_`).
5. **Vercel** (optional) — vercel.com — for deploying the Vite frontend.

---

## Environment files

Three files live in the repo root:

| File        | Purpose                                                     |
| ----------- | ----------------------------------------------------------- |
| `.env`      | Active env — what the app reads                             |
| `.env.test` | Stripe test keys (used by `npm run stripe:test`)            |
| `.env.live` | Stripe live keys (used by `npm run stripe:live`)            |

`.env` keys:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
GOOGLE_PLACES_API_KEY=
VITE_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRO_PRICE_ID=
```

`.env.test` / `.env.live` only carry the Stripe-mode-specific four:

```
VITE_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRO_PRICE_ID=
```

### Switching Stripe modes

```bash
npm run stripe:test    # writes .env.test values into .env, syncs Supabase config table
npm run stripe:live    # same with .env.live
```

The script (`scripts/stripe-switch.js`):
1. Overwrites the four Stripe keys in `.env` from the chosen file.
2. Upserts `stripe_mode`, `stripe_publishable_key`, and `stripe_webhook_secret` rows in the Supabase `config` table via the REST API using `SUPABASE_SERVICE_ROLE_KEY`.
3. Logs `✓ Switched to TEST mode` / `✓ Switched to LIVE mode`.

After switching, restart `npm run dev` (or redeploy in production) so Vite picks up the new keys.

---

## Database

Open Supabase SQL editor and run `supabase/schema.sql`. It creates `profiles`, `generated_sites`, `leads`, `config`, enables RLS, seeds config, installs an auth trigger that auto-creates a profile on signup, and (if `pg_cron` is enabled) schedules a monthly counter reset.

**Migration**: re-running `schema.sql` is idempotent — safe at any time. New tables (`chat_sessions`, `chat_messages`) and the `generated_sites.session_id` column are added with `if not exists`.

To re-seed config manually:

```sql
insert into config (key, value) values
  ('stripe_mode', 'test'),
  ('stripe_publishable_key', ''),
  ('stripe_webhook_secret', '')
on conflict (key) do nothing;
```

---

## Google OAuth setup

Required for "Continue with Google" sign-in. Without these steps you get `Error 400: redirect_uri_mismatch`.

1. **Google Cloud Console** → APIs & Services → **Credentials** → create or open the OAuth 2.0 Web client.
2. **Authorized JavaScript origins**:
   ```
   https://<project-ref>.supabase.co
   http://localhost:5173
   https://<your-vercel-domain>.vercel.app
   ```
3. **Authorized redirect URIs**:
   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```
4. **OAuth consent screen** → External → fill app name + support email → publish (or add test users).
5. **Supabase** → Authentication → Providers → **Google** → enable, paste Client ID + Client Secret, save.

---

## Deploy Edge Functions

```bash
npm install -g supabase
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>

supabase functions deploy generate-site
supabase functions deploy scrape-leads
supabase functions deploy create-checkout
supabase functions deploy create-portal
supabase functions deploy stripe-webhook
```

Set the Edge Function secrets:

```bash
supabase secrets set OPENAI_API_KEY=...
supabase secrets set OPENAI_MODEL=gpt-4o
supabase secrets set GOOGLE_PLACES_API_KEY=...
supabase secrets set STRIPE_SECRET_KEY=...
supabase secrets set STRIPE_WEBHOOK_SECRET=...      # placeholder, overwritten in next step
supabase secrets set STRIPE_PRO_PRICE_ID=...
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

`supabase/config.toml` already disables JWT verification on `stripe-webhook` (Stripe doesn't send a JWT). Other functions require an authenticated user.

---

## Stripe webhook setup

1. In Stripe Dashboard → Developers → Webhooks → **Add endpoint**.
2. URL: `https://<PROJECT_REF>.functions.supabase.co/stripe-webhook`
3. Events: `checkout.session.completed`, `customer.subscription.deleted`.
4. Copy the **Signing secret** (`whsec_...`).
5. Update both places:
   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
   ```sql
   update config set value = 'whsec_...' where key = 'stripe_webhook_secret';
   ```
6. Repeat for live mode when you go live.

---

## Deploy frontend (Vercel)

1. Push the repo to GitHub.
2. Import into Vercel — framework auto-detected (Vite).
3. Add env vars (same names as `.env`), then deploy.
4. After deploying, register the Stripe webhook (above) using the Supabase Functions URL — **not** the Vercel URL. The frontend never sees Stripe webhooks.

---

## Plan limits

| Feature                 | Free        | Pro ($19.99/mo)  |
| ----------------------- | ----------- | ----------------- |
| Website generations / mo| 3           | 10                |
| Leads / mo              | 100         | 1,000             |
| Full-screen preview     | yes         | yes               |
| Download HTML           | yes         | yes               |
| Lead export CSV         | —           | yes               |

Limits are enforced server-side inside Edge Functions (`generate-site`, `scrape-leads`). Counters reset on the first of each month via the `pg_cron` job created in `schema.sql`.

---

## Stripe test cards

`4242 4242 4242 4242` — any future expiry, any 3-digit CVC.

---

## Project layout

```
src/                  React app (Vite + Tailwind)
supabase/schema.sql   DB schema + RLS + triggers + cron
supabase/functions/   Deno Edge Functions
scripts/stripe-switch.js   Stripe mode toggle CLI
```
