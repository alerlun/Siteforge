# SiteForge — Security Audit

Date: 2026-05-24
Scope: full repo, all 5 Edge Functions, all frontend routes, secrets handling, deployment.

---

## Second pass — 2026-06-03

Re-audit found four items the first pass left open. All fixed in code:

### Rate-limit backend moved off Upstash to Postgres (was a deploy blocker)

The first pass built the limiter on Upstash Redis, but this project's stack is Supabase + Vercel only — and the rate-limited endpoints are **Supabase Edge Functions**, which don't run behind Vercel's edge, so Vercel WAF rate limiting can't cover them either. Until Upstash was provisioned the limiter failed open (silently off).

Replaced with a **Postgres-backed** limiter: `rate_limits` table + `check_rate_limit(p_key, p_limit, p_window_seconds)` SQL function (atomic fixed-window upsert, RLS-on / no policies so service-role-only), plus an hourly `pg_cron` purge. `_shared/ratelimit.ts` now calls the RPC on the existing service-role connection — no new secrets. Limits unchanged (gen 10/min, scrape 20/min, checkout/portal 10/min, webhook 120/min, IP + user keyed). Apply `schema.sql` to activate.

### Security headers (was unaddressed)

The first pass listed OWASP headers as in-scope but never shipped them — `vercel.json` carried no `headers` block. Added a `/(.*)` header rule on the SPA host:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self'` (build emits only external module scripts — verified, no inline); `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`; `font-src 'self' https://fonts.gstatic.com data:`; `img-src 'self' data: blob: https:`; `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com`; `frame-src 'self' blob:`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` |
| `X-DNS-Prefetch-Control` | `off` |

`style-src` keeps `'unsafe-inline'` because React writes inline `style` attributes and Google Fonts injects an inline stylesheet — `style-src` nonces aren't workable for a Vite SPA. `script-src` is strict (`'self'`), confirmed against `dist/index.html` (single external `<script type=module>`, zero inline scripts). No `X-Powered-By`/version header is emitted by a static Vite build; nothing to strip.

### Preview iframe — generated HTML could read the session token (was High)

`Chat.jsx` rendered the AI-generated site with `sandbox="allow-scripts allow-same-origin"`. That combination is self-defeating: scripts in the framed document run in the **app's own origin**, so generated/edited HTML could read `localStorage` — where the Supabase session JWT is stored (`persistSession: true`) — and exfiltrate it.

Fix: render the preview through a **`blob:` URL** with `sandbox="allow-scripts allow-forms allow-popups allow-modals"` (no `allow-same-origin`). The preview now runs in an opaque origin: it cannot touch the parent window or its storage, and — because a blob document does not inherit the parent CSP — generated sites still run their own inline scripts, fonts, and external images normally. `openFullscreen()` was changed from `document.write()` into `about:blank` (which inherited the app origin) to opening the same `blob:` URL with `noopener`.

### `.env.example` was stale/misleading (was Medium)

It listed `OPENAI_API_KEY` / `OPENAI_MODEL` (the live function uses **Anthropic**) and omitted the rate-limiter and Stripe-mode vars actually read by the code. Rewritten to match reality: `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `SUPABASE_URL`, `UPSTASH_REDIS_REST_URL`/`_TOKEN`, and the `*_TEST` / `*_LIVE` Stripe sets (plus legacy fallbacks), with public-vs-server-only clearly grouped.

### Residual after this pass

- **Fullscreen new tab still shares the app origin.** A `blob:` URL opened top-level is same-origin to the app, so the generated page's JS *can* read `localStorage` there. This is self-XSS (the user previewing their own generated content) and `noopener` blocks opener access — accepted as Low. The embedded preview (the common path) is fully isolated.
- **`script-src` strictness depends on the build staying inline-script-free.** Re-verify `dist/index.html` after Vite upgrades; if an inline bootstrap appears, add its hash to `script-src` rather than `'unsafe-inline'`.

---

## Resolved in this pass

### Rate limiting (Edge Functions)

Per-window sliding limits on every Edge Function, keyed by both `user.id` and client IP. Stripe webhook is keyed by IP only (no user).

| Endpoint | Limit |
|---|---|
| `generate-site` | 10 / min |
| `scrape-leads` | 20 / min |
| `create-checkout` | 10 / min |
| `create-portal` | 10 / min |
| `stripe-webhook` | 120 / min (per source IP) |

Backend: **Postgres (Supabase)** — see the *Second pass* note below. (Originally Upstash Redis; swapped because this project runs only Supabase + Vercel, and Supabase Edge Functions don't sit behind Vercel's edge.) Fixed-window counters via the `check_rate_limit()` SQL function, called on the existing service-role connection. Fails open only on a DB error — never silently off once `schema.sql` is applied.

The existing **monthly plan caps** (`profiles.generations_used`, `profiles.leads_used`) are unchanged and still enforced — the new per-minute limit is layered on top.

Files: `supabase/functions/_shared/ratelimit.ts`, wired in every `index.ts`.

### Auth rate limiting

The "5 attempts / 15 min" on login/signup/reset is configured in Supabase Dashboard → Authentication → Rate Limits — see `supabase/README.md` § 2. Login/signup/reset flows run client→Supabase directly (no custom endpoint to instrument), so this is a manual dashboard step.

### Input validation

Zod schemas in `supabase/functions/_shared/validation.ts` enforce:

- Field presence, type, length (e.g. `prompt` ≤ 4000 chars, `currentHtml` ≤ 500 KB).
- Enum constraints (`radius`, `websiteFilter`).
- UUID format on `sessionId`, `leadId`.
- URL format on `origin`.

Every function validates the parsed body and returns `400 invalid_input` with field-level issues on failure.

### Body size limits

`readBoundedJson()` / `readBoundedText()` in `_shared/guards.ts` enforce caps via `Content-Length` header + post-read size check:

| Endpoint | Cap |
|---|---|
| `generate-site` | 640 KB (edit-mode passes existing HTML back) |
| `scrape-leads`, `create-checkout`, `create-portal` | 32 KB |
| `stripe-webhook` | 512 KB (Stripe events can be large) |

Over-cap returns `413 payload_too_large`. Malformed JSON returns `400 invalid_json`.

### Secrets handling

`git log --all -- .env .env.live .env.test` is **empty** — no live secret has ever been committed to this repo's history. No `git filter-repo` step needed.

`.gitignore` already covers `.env`, `.env.live`, `.env.test`. `.env.example` is the only env file tracked.

**Manual step you must perform** (these CANNOT be done from code, and the live keys in your local `.env` should still be rotated as defence in depth — assume that anything ever written to disk on this machine may have been read by another process, including the Claude Code agent that wrote this file):

1. Rotate at the provider:
   - **Stripe**: Dashboard → Developers → API keys → "Roll" on the live secret key. Then Webhooks → "Roll signing secret".
   - **OpenAI**: Revoke the current `sk-proj-…` key, generate a new one. (OpenAI is referenced as a dependency in `package.json` even though the live Edge Function uses Anthropic — verify and remove if unused.)
   - **Anthropic**: Rotate `ANTHROPIC_API_KEY` if present in your local `.env`.
   - **Google Places**: Regenerate the key and add API-restriction (Places API only) + referrer/IP restriction in Google Cloud Console.
   - **Supabase service role**: Project Settings → API → Rotate service role key.
2. Push the new values to:
   - **Supabase** (`supabase secrets set KEY=value`) — for all server-only keys.
   - **Vercel** project env (Production + Preview) — only for `VITE_*` keys.
3. Delete the old values from `.env` locally. Keep `.env.example` as the template.

### Frontend exposure

Only three secrets ever reach the browser bundle, all by design and all safe to be public:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` (anon JWT — RLS is the control)
- `VITE_STRIPE_PUBLISHABLE_KEY` (publishable, not secret)

Grep of `src/` finds no `sk_live`, `sk_test`, `sk-proj`, or service-role JWTs. Verify after each build:

```bash
npm run build
grep -RIn "sk_live\|sk_proj\|whsec_\|AIza" dist/   # should return nothing
```

---

## Residual risks (not addressed in this pass)

| Risk | Severity | Note |
|---|---|---|
| **Service role key is a master key.** Any leak (from a logged env, a debug print, a future Edge Function bug) fully compromises the DB, bypassing RLS. | High | Mitigate by minimising places it's used and reviewing every `adminClient()` call site. |
| **Supabase RLS policies not audited in this pass.** | High | If an RLS policy is missing or permissive, a logged-in user can read other users' rows via the anon key directly — Edge Functions are not in that path. Schedule a follow-up review of `schema.sql`. |
| **CSRF not implemented.** | Low (current setup) | App uses Bearer tokens in `Authorization`, not cookies. As long as the auth scheme stays Bearer-only, CSRF is not exploitable. If you ever switch to cookie auth, this becomes High. |
| **No idle session timeout.** | Low | Supabase JWT expires after 1h and refreshes silently. A stolen long-lived refresh token is full access until manual revoke. Consider Settings → Auth → "Reuse interval" tightening. |
| **No bot mitigation / WAF.** | Medium | Per-IP rate limit blunts the basic case, but it's trivial to rotate IPs. Recommend enabling **Vercel BotID** (free tier, GA) and Vercel WAF managed rules on the SPA host. |
| **Stripe webhook endpoint not IP-allowlisted.** | Accepted | Stripe doesn't publish stable webhook IPs. Signature verification is the control; the existing HMAC-SHA256 + timestamp tolerance check is correct. |
| **No structured request logging / alerting.** | Medium | Rate-limit hits, 401s, 4xx clusters, and signature failures should page someone. Add minimal log fields (`event=rate_limited`, `endpoint`, `user_id_or_ip`) and a Supabase logflare drain or external SIEM. |
| ~~`UPSTASH_REDIS_REST_*` not yet provisioned.~~ | Resolved (2026-06-03) | Rate limiting moved to Postgres (`rate_limits` table + `check_rate_limit()`); no external provisioning. Just apply `schema.sql`. |
| **Tests are absent.** | Medium | No automated coverage for the new validation / size / RL paths. Add integration tests against a staging project before relying on the controls in prod. |
| **No dependency / SCA scan.** | Medium | Run `npm audit` and pin a Dependabot / `npm audit` CI step. The Deno imports in Edge Functions pull from `esm.sh` at fixed versions — review on each change. |
| **Open CORS (`Access-Control-Allow-Origin: *`).** | Low | Acceptable for now because requests require a valid Supabase JWT in `Authorization`. Tightening to the production origin removes one class of opportunistic abuse — recommended as a follow-up. |

---

## Verification commands

```bash
# 1. Validation
curl -X POST "$FN/generate-site" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{}'                                         # → 400 invalid_input

# 2. Body size (generate-site cap = 640 KB)
head -c 800000 /dev/urandom | base64 | \
  curl -X POST "$FN/generate-site" \
    -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
    --data-binary @-                              # → 413 payload_too_large

# 3. Per-window rate limit
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST "$FN/generate-site" \
    -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
    -d '{"prompt":"x"}'
done                                              # last calls → 429

# 4. Auth rate limit (via Supabase JS)
for i in $(seq 1 6); do curl -X POST "$SUPABASE/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"x@x","password":"wrong"}'; done   # 6th call → 429

# 5. Webhook signature
curl -X POST "$FN/stripe-webhook" \
  -H "stripe-signature: t=1,v1=deadbeef" \
  -d '{"type":"checkout.session.completed"}'      # → 400 invalid signature

# 6. Frontend bundle audit
npm run build && grep -RIn "sk_live\|sk_proj\|whsec_\|AIza" dist/   # → no matches
```

---

## Recommended follow-ups (ordered)

1. **Audit RLS** on every table (1-2h). This is the largest remaining attack surface.
2. **Tighten CORS** to production + preview origins (15m).
3. **Enable Vercel BotID + WAF** for the SPA (1h).
4. **Add `npm audit` + Dependabot** in CI (30m).
5. **Add integration tests** for the validation + RL + size paths (half-day).
6. **Structured logging + alerting** on 401/429/signature failures (half-day).
