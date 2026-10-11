# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev          # Vite dev server on :5173
npm run build        # production build to dist/
npm run stripe:test  # copy .env.test Stripe keys into .env + upsert Supabase `config` rows
npm run stripe:live  # same with .env.live
```

## Arbetsregler
- Ändra aldrig produktionsdatabasen direkt. Alla DB-ändringar görs som migrationsfiler i supabase/migrations som jag granskar först.
- Fråga innan du raderar filer, tabeller eller kolumner.
- Gör en liten, avgränsad ändring i taget och förklara vad du ändrat.
- Kör build/lint/tester efter varje ändring om sådana finns.
- Svara på svenska.

No test runner, linter, or typecheck is configured. Verify frontend changes with `npm run build` and manually in the browser.

Edge Functions (Deno) deploy individually: `supabase functions deploy <name>`. Secrets via `supabase secrets set`. DB changes: add a new migration file `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` (one focused change per file), have it reviewed, then apply it (`supabase db push` or the SQL editor). Never edit `supabase/schema.sql` — it is a frozen baseline of the schema as of 2026-10-07; the current schema = `schema.sql` + all migrations in order.

## Architecture

SiteForge: AI website generator for local-business outreach. Generate a site for a business, scrape leads, track sales.

**Frontend** (`src/`): React 18 + Vite + Tailwind, React Router v6 (routes in `src/App.jsx`). `/app/*` is behind `ProtectedRoute`; Leads/Stats/Settings/Editor are lazy-loaded. Deployed on Vercel (`vercel.json` sets strict CSP — new third-party origins need adding to `connect-src`/`script-src` there).

**Backend** is Supabase only: Postgres + RLS, Auth, and Deno Edge Functions in `supabase/functions/`. The browser talks to the DB directly via supabase-js (RLS-protected) for plain reads, and calls Edge Functions through `callFunction()` in `src/lib/api.js` for anything privileged (AI, Stripe, scraping, credits, referrals). `callFunction` also parses SSE: `generate-site` streams `text/event-stream` and the client reads until a `result` or `error` event; pre-stream failures are plain JSON with non-2xx status (`err.status`, `err.data`).

**Edge Function conventions** (`supabase/functions/_shared/`): `auth.ts` (`getUser` validates the bearer token; `adminClient` uses the service role and bypasses RLS), `guards.ts` (`HttpError`, bounded body readers, `clientIp`), `ratelimit.ts` (Postgres-backed via `check_rate_limit()` RPC — no external service), `validation.ts`, `cors.ts`, `stripe.ts`, `referral.ts`. `stripe-webhook` has `verify_jwt = false` (set in `supabase/config.toml`) and verifies signatures itself. Functions that are new must be added to `config.toml` if they need non-default JWT behaviour.

**AI**: `generate-site` and `edit-element` call the Anthropic API (`ANTHROPIC_MODEL`, a Haiku model for classification). The system prompt in `generate-site/index.ts` locks design families (Editorial Boutique / Brutalist / Gradient Mesh) and takes a `style` + creative seed. Output is HTML rendered in sandboxed iframes (CSP `frame-src 'self' blob:`). The Editor page does element-level edits through `edit-element`.

**Credits system**: usage is metered in credits, not generation counts. Cost = `(input_tokens*inRate + output_tokens*outRate) * margin`. Rates and monthly allowances (free/pro) live in **two places that must be kept in sync**: the DB `config` table and `src/lib/credits.js` (client-side estimates for pre-flight checks). Server deducts through the `deduct_credits` RPC and records in `credit_ledger`; monthly reset via `reset_monthly_counters()` (pg_cron). Note `_shared/auth.ts` `PLAN_LIMITS` and the README plan table are legacy generation/lead counts.

**Stripe mode** is runtime-selected by the `stripe_mode` row in the `config` table (`test`|`live`); `_shared/stripe.ts` picks `*_TEST` / `*_LIVE` secrets accordingly (live has no fallback). `scripts/stripe-switch.js` flips the local `.env` and the DB row together.

**Referrals**: `claim-referral`, `generate-referral-code`, `referral-stats` functions + `referral_activations` table + `process_referrals()` and `handle_new_user()` in `schema.sql` (baseline; later changes in `supabase/migrations/`); client side in `src/lib/referral.js` (pending code is stored client-side until signup completes). Design docs in `docs/superpowers/specs/` and plans in `docs/superpowers/plans/`.

**Env**: `VITE_*` vars are public and bundled; everything else is server-only and lives in Supabase secrets. `.env`, `.env.test`, `.env.live` are gitignored; `.env.example` is the reference list. `SECURITY_AUDIT.md` documents the hardening pass and `supabase/README.md` lists required dashboard settings (auth rate limits, redirect URLs).

## Stale docs

`README.md` and `TODO.md` still describe OpenAI (`gpt-4o`) and old per-generation plan limits; the code now uses Anthropic and credits. Trust the code and `supabase/README.md` over them.
