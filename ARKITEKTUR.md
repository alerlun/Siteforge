# SiteForge – Arkitektur

> Skriven 2026-10-07 efter genomgång av hela kodbasen (`src/`, `supabase/functions/`, `supabase/schema.sql`, `scripts/`, `vercel.json`) och en **skrivskyddad** inspektion av live-databasen (tabeller, RLS-policies, funktioner, triggers, cron-jobb, rättigheter, edge functions).
> `README.md` och `TODO.md` är inaktuella (beskriver OpenAI och gamla plangränser) – lita på detta dokument och koden.
> Avsnitt 8 listar avvikelser och risker som hittades under genomgången.
>
> **Uppdaterad 2026-10-11 (kväll)** efter credits-, Stripe-, värvnings- och leadsfixarna (se åtgärdsloggen i `CREDITS-ANALYS.md`). Avsnitt 3–5 beskriver det nuvarande flödet; avsnitt 8 visar vad som är åtgärdat.
>
> **Omverifierad 2026-10-12** mot koden (`audit-fixes`, 9b7ebb8) och live-DB (skrivskyddat: policies, tabell- och funktionsrättigheter, triggers, cron, `config`, migrationslistan, edge functions med versioner). Tillägg: REVOKE-migrationen, tomma SEARCH-block, `config.toml`-avvikelse för värvningsfunktionerna (8.3 punkt 20) och öppna fynd från kodgranskningen (8.4).

---

## 1. Vad appen gör (användarens perspektiv)

SiteForge är ett verktyg för den som säljer hemsidor till lokala småföretag.

1. **Hitta kunder (Leads)** – användaren söker t.ex. "frisör i Karlstad". Appen hämtar företag från Google Places, filtrerar som standard bort de som redan har en hemsida och sparar dem som leads (namn, telefon, adress, betyg, antal recensioner).
2. **Generera en hemsida (Chat)** – från en lead (eller fritt) skriver användaren en beskrivning i ett chattgränssnitt. AI (Anthropic Claude) bygger en komplett enkelsidig HTML-sajt i en slumpad designstil, på det språk som passar orten. Följdmeddelanden i samma chatt tolkas som *ändringar* av sajten eller som *ny sajt* (en liten klassificeringsmodell avgör).
3. **Finjustera (Editor)** – fullskärmseditor där användaren klickar på ett enskilt element och ber AI ändra just det. Sajten kan laddas ner som `.html`.
4. **Följa försäljning (Stats)** – varje genererad sajt kan markeras med status och försäljningspris; Stats visar intäkter och konvertering.
5. **Konto (Settings)** – plan (Free/Pro), kreditsaldo, kredithistorik (senaste 20), antal leads använda, uppgradera via Stripe, hantera prenumeration, värvningslänk.
6. **Värvning** – varje användare har en kod (`SF-XXXXXX`). Var 5:e bekräftad värvning ger 1 månad Pro + påfyllning till Pro-krediter.

Planer (enligt `Landing.jsx`): **Free** $0 – 68k krediter/mån, 10 leads/mån. **Pro** $29.99/mån – 680k krediter/mån, 100 leads/mån.

---

## 2. Teknikstack och mappstruktur

| Lager | Teknik |
|---|---|
| Frontend | React 18, Vite 5, Tailwind 3, React Router v6, Recharts, PapaParse (CSV-export) |
| Hosting frontend | Vercel (statisk SPA, `vercel.json` med strikt CSP + säkerhetsheaders) |
| Backend | Supabase: Postgres + RLS, Auth, Edge Functions (Deno), pg_cron |
| AI | Anthropic Messages API (direkt via `fetch`, streaming) |
| Betalning | Stripe Checkout + Billing Portal + webhook (direkt via `fetch`, egen signaturverifiering) |
| Leads | Google Places API (Text Search + Place Details) |
| Analys | Google Analytics 4 med Consent Mode v2 (avstängt om `VITE_GA_MEASUREMENT_ID` saknas) |

Det finns ingen egen server – webbläsaren pratar direkt med Postgres (RLS-skyddat) för enkla läsningar/skrivningar och anropar Edge Functions för allt privilegierat.

```
siteforge/
├── index.html, vite.config.js, tailwind.config.js, postcss.config.js
├── vercel.json                 # SPA-rewrite + CSP/säkerhetsheaders
├── package.json                # scripts: dev, build, stripe:test, stripe:live
├── scripts/stripe-switch.js    # byter Stripe-nycklar i .env + config.stripe_mode i DB
├── src/
│   ├── main.jsx, App.jsx       # routing; /app/* bakom ProtectedRoute
│   ├── lib/
│   │   ├── supabase.js         # supabase-js-klient (anon key)
│   │   ├── auth.jsx            # AuthProvider, useAuth, isProUser
│   │   ├── api.js              # callFunction() + SSE-läsare, PLAN_LIMITS (leads)
│   │   ├── credits.js          # klientkopia av kreditsatser/allowance
│   │   ├── referral.js         # pending-kod i localStorage, claim/stats
│   │   ├── analytics.js        # GA4 + consent
│   │   └── utils.js            # download, format, nextResetDate
│   ├── pages/                  # Landing, Login, Signup, Privacy, Terms,
│   │                           # AppLayout, Chat, Leads, Stats, Settings, Editor
│   └── components/             # Sidebar, ProtectedRoute, SaleModal, SessionsPanel,
│                               # StatusBadge, ConsentBanner, LegalLayout
├── supabase/
│   ├── schema.sql              # fryst utgångsläge av DB-schemat (2026-10-07) – redigeras inte
│   ├── migrations/             # alla DB-ändringar efter 2026-10-07 (skapas med första migrationen)
│   ├── config.toml             # verify_jwt per funktion
│   ├── README.md               # dashboardinställningar (auth rate limits, redirect-URL:er)
│   └── functions/
│       ├── _shared/            # auth, cors, guards, ratelimit, validation, stripe, referral
│       ├── generate-site/      # AI-generering/ändring av hel sajt (SSE)
│       ├── edit-element/       # AI-ändring av ett element
│       ├── scrape-leads/       # Google Places → leads
│       ├── create-checkout/    # Stripe Checkout-session
│       ├── create-portal/      # Stripe Billing Portal-session
│       ├── stripe-webhook/     # Stripe-händelser → profiles.plan
│       ├── claim-referral/     # koppla värvningskod efter signup
│       ├── generate-referral-code/
│       └── referral-stats/
├── docs/superpowers/           # specar och planer (referral, mobil/kostnad)
└── SECURITY_AUDIT.md
```

**Rutin för DB-ändringar (beslutad 2026-10-07):** `schema.sql` är ett fryst utgångsläge som motsvarar live-databasen 2026-10-07 och redigeras inte längre. Varje ändring görs som en ny fil `supabase/migrations/<YYYYMMDDHHMMSS>_<namn>.sql`, med en avgränsad ändring per fil. Filen granskas innan den körs (`supabase db push` eller SQL-editorn). Aktuellt schema = `schema.sql` + alla migrationer i ordning. Fram till 2026-10-07 applicerades schemat genom att köra `schema.sql` manuellt. Alla migrationer i `supabase/migrations/` är körda mot live-databasen och registrerade (`supabase_migrations.schema_migrations`), senast `20261012110000_revoke_client_grants_internal_tables` (verifierat 2026-10-12, 11 migrationer).

### Routes (`src/App.jsx`)

| Route | Sida | Skydd |
|---|---|---|
| `/`, `/login`, `/signup`, `/privacy`, `/terms` | publika | – |
| `/app/chat` | Chat | ProtectedRoute |
| `/app/leads`, `/app/stats`, `/app/settings` | lazy-laddade | ProtectedRoute |
| `/app/editor/:siteId` | Editor (lazy) | ProtectedRoute |

`ProtectedRoute` kontrollerar bara att en Supabase-session finns (klientsidan); den egentliga åtkomstkontrollen är RLS + Edge Functions.

---

## 3. Tabeller och hur de hänger ihop

Alla tabeller ligger i `public` och har RLS påslaget.

```
auth.users ──1:1──> profiles ──┬──< leads ──0..1── chat_sessions.lead_id (unik)
   (trigger)          │  ▲     ├──< chat_sessions ──< chat_messages ──> generated_sites (site_id)
                      │  │     │        ▲
                      │  │     ├──< generated_sites (session_id ──> chat_sessions)
                      │  │     ├──< credit_ledger ──> generated_sites (site_id)
                      │  └─────┴── profiles.referred_by (självreferens)
                      └──< referral_activations (referrer_id, referred_id)

config        (nyckel/värde, fristående)
rate_limits   (nyckel/räknare, fristående)
stripe_events (Stripe event-id, dedup för webhooken)
```

| Tabell | Syfte | Viktiga kolumner | Relationer |
|---|---|---|---|
| `profiles` | En rad per användare | `plan` (enum `free`/`pro`), `credit_balance`, `leads_used`, `generations_used` (endast statistik), `stripe_customer_id`, `stripe_subscription_id`, `referral_code` (unik), `referred_by`, `referral_count`, `referral_milestone`, `pro_until`, `signup_ip` | `id` → `auth.users.id` (cascade) |
| `leads` | Hämtade företag | `business_name`, `phone`, `address`, `rating`, `review_count`, `has_website`, `website_url`, `email`, `business_type`, `status` (`new` …) | `user_id` → profiles |
| `chat_sessions` | En chattråd | `title`, `updated_at`, `lead_id` (unik när satt → en chatt per lead) | `user_id` → profiles, `lead_id` → leads (set null) |
| `chat_messages` | Meddelanden i en tråd | `role` (`user`/`assistant`), `content`, `site_id` | `session_id` → chat_sessions (cascade), `site_id` → generated_sites (set null) |
| `generated_sites` | Varje genererad/ändrad sajtversion | `html_output`, `status` (`pending` …), `sale_price`, `business_name/type`, `client_location` | `user_id` → profiles, `session_id` → chat_sessions (set null) |
| `credit_ledger` | En rad per ändring av saldot (avdrag och påfyllning) | `action_type` (`generation`/`edit`/`element_edit`/`monthly_reset`/`renewal`/`plan_upgrade`/`referral_bonus`/`manual_correction`), `status` (`reserved`/`settled`/`refunded`), `delta` (±), `balance_after`, `credits_charged`, `input_tokens`, `output_tokens`, `cache_write_tokens`, `cache_read_tokens` | `user_id` → profiles, `site_id` → generated_sites |
| `stripe_events` | En rad per tillämpad Stripe-händelse (dedup) | `id` (Stripe event-id), `type`, `user_id`, `received_at` | `user_id` → profiles (set null) |
| `referral_activations` | En rad per värvningsrelation | `status` (`pending`/`confirmed`/`rejected`), `reject_reason`, `first_generation_at`, `confirmed_at`, `signup_ip` | `referrer_id`, `referred_id` (unik) → profiles |
| `config` | Inställningar utan deploy | nycklar: `credit_in_rate`, `credit_out_rate`, `credit_margin`, `credit_monthly_free`, `credit_monthly_pro`, `stripe_mode`, `stripe_publishable_key`, `stripe_webhook_secret` | – |
| `rate_limits` | Fast-fönster-räknare för rate limiting | `key`, `count`, `window_start` | – |

Varje ny sajtversion (även en chatt-ändring) blir en **ny rad** i `generated_sites`; Chat läser senaste raden per session. Element-ändringar i Editor skriver däremot över `html_output` på befintlig rad.

### Databasfunktioner, triggers och cron (verifierat mot live-DB 2026-10-11)

Alla funktioner nedan är SECURITY DEFINER med `search_path = public` och kan bara köras av `postgres` (cron) och `service_role` (Edge Functions), utom `handle_new_user` (triggerfunktion, kan inte anropas som RPC) och `effective_plan` (ren hjälpfunktion).

| Objekt | Gör | Migration |
|---|---|---|
| `handle_new_user()` (trigger `on_auth_user_created`, AFTER INSERT på `auth.users`) | Skapar `profiles`-rad med `credit_balance = config.credit_monthly_free` och unik `referral_code` (`extensions.gen_random_bytes`). Läser `raw_user_meta_data.referral_code` och skapar `referral_activations`. | baseline, `20261011190000` |
| `effective_plan(plan, pro_until)` | `'pro'` om `plan = 'pro'` eller `pro_until` i framtiden, annars `'free'`. Samma regel som `isProUser()` i klienten och `scrape-leads`. | `20261011120000` |
| `grant_credits(user, reason)` | **Enda vägen att fylla på.** Låser profilraden, sätter saldot och skriver en ledger-rad i samma transaktion. `monthly_reset`/`renewal` → saldo := tilldelning. `plan_upgrade`/`referral_bonus`/`manual_correction` → saldo := max(saldo, tilldelning). Tilldelning efter `effective_plan`. | `20261011120000` |
| `reserve_credits(user, belopp, typ)` | Före AI-anrop: drar estimatet **bara om saldot räcker** och skapar ledger-rad `reserved`. Returnerar rad-id eller NULL (→ 402). | `20261011220000` |
| `settle_credits(rad, credits, tokens…, sajt)` | Efter lyckat AI-anrop: justerar saldot med (verklig − estimat) och sätter raden till `settled` med alla tokens, `delta`, `balance_after`. | `20261011220000` |
| `refund_credits(rad)` | Efter misslyckat AI-anrop: ger tillbaka estimatet, raden blir `refunded`. | `20261011220000` |
| `reset_monthly_counters()` | Nollställer `leads_used`/`generations_used` för alla, och kör `grant_credits(id, 'monthly_reset')` för alla **utom** aktiva Stripe-prenumeranter (de fylls på via `invoice.paid`). Loggar antal. Fel → hela reseten rullas tillbaka. | `20261011130000`, `20261011210000` |
| `stripe_apply_checkout(event, user, kund, prenumeration)` | Idempotent per Stripe-händelse (`stripe_events`): `plan = 'pro'`, Stripe-id:n, `grant_credits(user, 'plan_upgrade')`. | `20261011140000` |
| `stripe_apply_renewal(event, kund)` | Idempotent: `grant_credits(user, 'renewal')` för Pro-profilen med den kunden. | `20261011140000` |
| `confirm_referral(activation)` | Atomisk bekräftelse av en värvning: bara `pending`, dagstak 10/värvare/24 h, `referral_count + 1`, vid var 5:e: `pro_until += 1 månad` + `grant_credits(värvare, 'referral_bonus')`. | `20261012100000` |
| `process_referrals()` | Cron: anropar `confirm_referral` för varje pending värvning vars `first_generation_at` är äldre än 24 h. | `20261012100000` |
| `check_rate_limit(key, limit, window)` | Atomisk upsert-räknare för rate limiting. | baseline |
| `purge_rate_limits()` | Raderar räknare äldre än 1 h. | baseline |

`deduct_credits` är borttagen (`20261011230000`), ersatt av reserve/settle/refund.

| Cron-jobb (pg_cron) | Schema | Anrop |
|---|---|---|
| `siteforge_reset_monthly` | `0 0 1 * *` (1:a varje månad 00:00 UTC = 01:00/02:00 svensk tid) | `reset_monthly_counters()` |
| `siteforge_process_referrals` | `0 * * * *` (varje timme) | `process_referrals()` |
| `siteforge_purge_rate_limits` | `0 * * * *` (varje timme) | `purge_rate_limits()` |

Inga andra triggers finns på `public`-tabellerna.

---

## 4. Credits – hela flödet

**Princip (sedan 2026-10-11):** varje ändring av `profiles.credit_balance` görs av en DB-funktion som skriver en rad i `credit_ledger` i **samma transaktion**. Saldot kan därför alltid stämmas av mot ledgern (`delta`, `balance_after`). Klienten kan bara läsa sitt saldo och sin ledger.

**Formel** (`computeCredits` i `generate-site` och `edit-element`):

```
credits = ceil( ( input_tokens        * in_rate
                + cache_write_tokens  * in_rate * 2
                + cache_read_tokens   * in_rate * 0.1
                + output_tokens       * out_rate ) * margin )
```

Värden i `config`: `in_rate = 1`, `out_rate = 5`, `margin = 1.1`. `edit-element` använder ingen cache.

### 4.1 Var satserna finns

| Plats | Innehåll | Används till |
|---|---|---|
| DB `config` (`credit_in_rate`, `credit_out_rate`, `credit_margin`, `credit_monthly_free` = 68 000, `credit_monthly_pro` = 680 000) | Sanningen | Edge Functions vid varje anrop, `handle_new_user`, `grant_credits` |
| `src/lib/credits.js` (`CREDIT_RATES`, `MONTHLY_ALLOWANCE`, estimat) | Hårdkodad kopia (klienter kan inte läsa `config`) | Endast UI: skicka-knappen, "x / y credits", stapeln i Settings. Estimaten måste matcha serverns, annars aktiveras knappen men servern svarar 402. |

### 4.2 Livscykel

| Steg | Ansvarig kod / funktion | Ledger `action_type` |
|---|---|---|
| **Signup** | `handle_new_user()` sätter saldo = Free-tilldelning | – (ingen rad) |
| **Uppgradering via Stripe** | `stripe-webhook` → `stripe_apply_checkout` → `grant_credits` | `plan_upgrade` |
| **Förnyelse via Stripe** (på faktureringsdatum) | `stripe-webhook` (`invoice.paid`, `subscription_cycle`) → `stripe_apply_renewal` → `grant_credits` | `renewal` |
| **Månadsreset** (1:a, 00:00 UTC) | `reset_monthly_counters()` → `grant_credits` för alla utom aktiva Stripe-prenumeranter. Oanvända credits rullar inte över. | `monthly_reset` |
| **Värvningsbonus** (var 5:e bekräftade) | `confirm_referral()` (från cron eller `generate-site`) → `grant_credits` | `referral_bonus` |
| **Manuell rättelse** | Migration som kör `grant_credits(id, 'manual_correction')`. Ändra aldrig saldot direkt i dashboarden. | `manual_correction` |
| **Nedgradering** | `stripe-webhook` (`customer.subscription.deleted`): `plan = 'free'`. Saldot behålls till nästa månadsreset. Misslyckade betalningar nedgraderar inte (Stripe gör omförsök och skickar sedan `subscription.deleted`). | – |
| **Avdrag: ny sajt / chatt-ändring** | `generate-site`: (1) klassificering ny/ändring (Haiku), (2) `reserve_credits(estimat)` → 402 om saldot inte räcker, (3) AI-anrop, (4) `settle_credits(verklig kostnad)`, eller vid fel `refund_credits` | `generation` / `edit` |
| **Avdrag: element-ändring** | `edit-element`: samma reserve → settle/refund | `element_edit` |
| **Visas** | `AuthProvider` (`src/lib/auth.jsx`) läser `profiles` vid inloggning, fokus på fliken, varje sidbyte och efter varje åtgärd eller fel. Exakt saldo i Chat/Editor/Settings. Settings visar ledgern (senaste 20) med typ, ±förändring och saldo efter. | – |

**Estimat (server = klient):**

| Åtgärd | Estimat | Verklig kostnad (okt 2026) |
|---|---|---|
| Ny sajt | 1 200 in + 2 000 cache write + 10 000 ut ≈ 60 721 (≈ 62 701 med chatthistorik) | 47 000–70 000 |
| Chatt-ändring | (sajtens tecken / 2,5 + 1 500) in + 3 000 ut ≈ 26 000–35 000 | ~13 000 |
| Element-ändring | 500 in + 3 000 ut = 17 050 | 250–2 200 |

Chatt-ändringar svarar med SEARCH/REPLACE-block, inte hela sajten. Varje block måste matcha exakt ett ställe, annars avvisas hela ändringen och reservationen återbetalas. Block med tom SEARCH-del avvisas också (gav tidigare oändlig loop, rättat i 9b7ebb8, deployat som generate-site v43).

En reservation som aldrig avslutas (funktionen dör) ligger kvar som `reserved`. Användaren har då betalat estimatet, inget mer. Sådana rader hittas med `status = 'reserved'` och gammal `created_at`.

**Leads** mäts inte i credits: `scrape-leads` använder `PLAN_LIMITS` (free 10, pro 100 per månad) efter effektiv plan, mot `profiles.leads_used`, som nollställs av månadsreseten. Google Places-fel (t.ex. `REQUEST_DENIED` när fakturering är avstängd) visas som fel i appen.

---

## 5. Betalflödet (Stripe)

### 5.1 Läge test/live
`config.stripe_mode` (`test`|`live`) styr vilka secrets `_shared/stripe.ts` använder: `STRIPE_*_LIVE` (obligatoriska i live, inget fallback) eller `STRIPE_*_TEST`. `npm run stripe:test|live` (`scripts/stripe-switch.js`) kopierar nycklar till lokal `.env` **och skriver `stripe_mode` i live-databasen**. ⚠️ Medan `test` är satt går alla riktiga användares uppgraderingar till Stripes testläge. Växla alltid tillbaka med `npm run stripe:live`.

### 5.2 Uppgradering
1. Settings → "Upgrade to Pro" → `create-checkout` skapar en Stripe Checkout-session (`mode=subscription`, `client_reference_id = user.id`, befintlig `customer` eller `customer_email`).
2. Efter betalning → `/app/settings?upgraded=true`, som laddar om profilen.
3. Stripe skickar `checkout.session.completed` → `stripe_apply_checkout`: Pro + 680 000 credits direkt.

### 5.3 Webhook (`stripe-webhook`, `verify_jwt = false`)
- Rate limit 120/min per IP, max 512 kB body. Verifierar `Stripe-Signature` själv (HMAC-SHA256, 300 s tolerans).
- Stripe-endpoints (live och test) prenumererar på exakt dessa tre händelser (verifierat via Stripe API 2026-10-11):

| Händelse | Effekt |
|---|---|
| `checkout.session.completed` | `stripe_apply_checkout`: `plan = 'pro'`, Stripe-id:n, `grant_credits('plan_upgrade')` |
| `invoice.paid` med `billing_reason = 'subscription_cycle'` | `stripe_apply_renewal`: `grant_credits('renewal')`. Första fakturan (`subscription_create`) ignoreras, den täcks av checkout. |
| `customer.subscription.deleted` | `plan = 'free'`, nollar Stripe-id:n. Saldot behålls till den 1:a. |
| Allt annat | Ignoreras, svarar 200 |

- **Idempotens:** varje händelse registreras i `stripe_events` (id = Stripe event-id) i samma transaktion som den tillämpas. En upprepad händelse gör ingenting.
- **Fel:** alla DB-fel ger 500 och loggas, så att Stripe försöker igen.

### 5.4 Hantera prenumeration
Settings → "Manage Billing" → `create-portal` → Stripe Billing Portal. Uppsägning leder vid periodens slut till `customer.subscription.deleted`.

### 5.5 Vid förnyelse
Stripe skickar `invoice.paid` (`subscription_cycle`) på faktureringsdatumet. Saldot sätts då till 680 000 och en `renewal`-rad skrivs. Månadsreseten den 1:a hoppar över aktiva Stripe-prenumeranter, så de får exakt en påfyllning per period. Testat med Stripe test clock 2026-10-11.

---

## 6. Autentisering och behörigheter

### 6.1 Inloggning
Supabase Auth direkt från webbläsaren: e-post/lösenord (`signUp` med e-postbekräftelse, `signInWithPassword`, `resetPasswordForEmail`) och Google OAuth (`signInWithOAuth`). Redirect till `/app/chat`. Sessionen sparas av supabase-js (`persistSession`, `autoRefreshToken`). `AuthProvider` läser `profiles`-raden (`select *`) och exponerar `user`, `profile`, `refreshProfile`. Auth-rate limits och redirect-URL:er sätts i dashboarden (se `supabase/README.md`).

### 6.2 Edge Functions
Alla funktioner utom `stripe-webhook` validerar själva bearer-token med `getUser()` (`supabase.auth.getUser(token)` via service role). De använder sedan `adminClient()` (service role, **kringgår RLS**) och filtrerar manuellt på `user.id`.

| Funktion | verify_jwt i `config.toml` | verify_jwt live | Egen auth | Rate limit |
|---|---|---|---|---|
| generate-site | true | true (sedan deploy 2026-10-11) | `getUser` | 10/min IP + användare |
| edit-element | (ej angiven) | true | `getUser` + ägarkontroll av sajt | delar `generate`-gränsen |
| scrape-leads | true | true | `getUser` | 20/min |
| create-checkout | true | true | `getUser` | 10/min |
| create-portal | true | true | `getUser` | 10/min |
| stripe-webhook | false | false | Stripe-signatur | 120/min IP |
| claim-referral | (ej angiven) | false | `getUser`, 1 h-fönster efter signup | – |
| generate-referral-code | (ej angiven) | false | `getUser` | – |
| referral-stats | (ej angiven) | false | `getUser` | – |

Rate limiting är fail-open (DB-fel → anropet släpps igenom). CORS är `*`.

Funktioner som saknas i `config.toml` får standardvärdet `verify_jwt = true` vid nästa `supabase functions deploy`. För `edit-element` stämmer det med live; för de tre värvningsfunktionerna (live `false`) ändras beteendet vid nästa deploy (se 8.3 punkt 20).

### 6.3 RLS – vem får läsa/skriva vad (roll `authenticated`)

| Tabell | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| profiles | egen rad | – | – | – |
| leads | egna | egna | egna | egna |
| chat_sessions | egna | egna | egna | egna |
| chat_messages | egna | egna | egna | egna |
| generated_sites | egna | egna | egna | egna |
| credit_ledger | egna | – | – | – |
| referral_activations | där man är värvare eller värvad | – | – | – |
| config | – | – | – | – |
| rate_limits | – | – | – | – |

`anon` har inga policies och ser alltså inga rader. Service role (endast i Edge Functions och `stripe-switch.js`) ser och skriver allt.

`profiles` är skrivskyddad för klienter sedan migrationen 2026-10-07: policyerna för insert/update är borttagna, och `anon`/`authenticated` har bara SELECT på tabellen. Profilrader skapas av `handle_new_user()` och ändras bara av Edge Functions och DB-funktioner.

**Tabellrättigheter (live 2026-10-11):** `anon`/`authenticated` har inga rättigheter på `config`, `rate_limits` och `stripe_events`, bara SELECT på `profiles`, `credit_ledger` och `referral_activations`, och full åtkomst (begränsad av RLS) på de fyra "egna"-tabellerna `leads`, `chat_sessions`, `chat_messages`, `generated_sites`.

Vad klienten skriver direkt (RLS): `chat_messages` (insert/update), `chat_sessions` (delete), `leads.status`, `generated_sites` (status/pris/namn via SaleModal, `html_output` via Editor).

---

## 7. Externa tjänster och nycklar

Inga värden anges här.

| Tjänst | Variabel | Var den ligger | Används av |
|---|---|---|---|
| Supabase (publik) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `.env` lokalt, Vercel env; bundlas i klienten | `src/lib/supabase.js`, `api.js` |
| Supabase (server) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge secrets (injiceras automatiskt); service role även i lokal `.env` för `stripe-switch.js` | `_shared/auth.ts` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default i kod `claude-sonnet-4-6`), `ANTHROPIC_CLASSIFY_MODEL` (default `claude-haiku-4-5-20251001`) | Supabase Edge secrets | `generate-site`, `edit-element` |
| Google Places | `GOOGLE_PLACES_API_KEY` | Supabase Edge secrets | `scrape-leads` |
| Stripe | `STRIPE_SECRET_KEY_{TEST,LIVE}`, `STRIPE_PRO_PRICE_ID_{TEST,LIVE}`, `STRIPE_WEBHOOK_SECRET_{TEST,LIVE}` (+ legacy osuffixade) | Supabase Edge secrets; lokalt i `.env.test`/`.env.live` | `_shared/stripe.ts` |
| Stripe (publik) | `VITE_STRIPE_PUBLISHABLE_KEY` | `.env`; används inte av någon kod i `src/` idag | – |
| Stripe (i DB) | `config.stripe_publishable_key`, `config.stripe_webhook_secret` | Tabellen `config` (endast service role) | Skrivs av `stripe-switch.js`, läses inte av någon funktion |
| App-URL | `APP_URL` (valfri, fallback `https://siteforge-vert.vercel.app`) | Supabase Edge secrets | `referral-stats` (värvningslänk) |
| Google Analytics | `VITE_GA_MEASUREMENT_ID` | `.env`, Vercel env (publik) | `src/lib/analytics.js` |
| Google Fonts | – | Laddas i genererade sajter och appens CSS | CSP tillåter `fonts.googleapis.com`/`fonts.gstatic.com` |

`.env`, `.env.test`, `.env.live` är gitignorerade; `.env.example` är referenslistan.

---

## 8. Avvikelser och risker som hittades

Status 2026-10-12: punkt 1–12 och 17–19 är åtgärdade (✅). Kvar: 10 (delvis), 13, 14, 16, 20 och 21–29 (8.4).

### 8.1 Säkerhet

1. ✅ **Åtgärdad 2026-10-07/11.** ~~**Användare kan skriva valfria värden i sin egen profil.**~~ Policyn `profiles self update` saknar kolumnbegränsning, och rollen `authenticated` har UPDATE på alla kolumner (verifierat i live-DB). En inloggad användare kan med anon-nyckeln och sin egen token köra t.ex. `supabase.from('profiles').update({ credit_balance: 999999999, plan: 'pro', pro_until: '2099-01-01' })` och få obegränsade krediter och Pro gratis. Detsamma gäller `leads_used`, `referral_count`, `stripe_customer_id` m.fl.
2. ✅ **Åtgärdad** (EXECUTE återkallad, `deduct_credits` avvisar negativa belopp). ~~**SECURITY DEFINER-funktioner är anropbara av `anon` och `authenticated`**~~ (standard-EXECUTE till PUBLIC är inte återkallad – verifierat):
   - `deduct_credits(p_user_id, p_credits)` – vem som helst kan dra krediter från *vilken användare som helst*, eller skicka ett negativt belopp och ge sig själv krediter.
   - `reset_monthly_counters()` – vem som helst kan återställa alla användares saldon när som helst.
   - `process_referrals()` och `check_rate_limit()` – kan anropas utifrån (mindre allvarligt).
3. ✅ **Åtgärdad:** `authenticated` har inte längre INSERT på `credit_ledger`, bara SELECT.
3b. ✅ **Åtgärdad** (`20261012110000`: `config`/`rate_limits` inga klienträttigheter, `referral_activations` bara SELECT). ~~**Ny (2026-10-11, låg risk):**~~ `anon` och `authenticated` har fortfarande alla tabellrättigheter på `config`, `rate_limits` och `referral_activations` (Supabase-standard). Ingen policy tillåter skrivning, så RLS stoppar det i dag. Om någon av misstag lägger till en bred policy eller stänger av RLS på `config`, kan klienter läsa `stripe_webhook_secret` och ändra kreditsatserna. Det kan stängas med en REVOKE i en senare migration.

### 8.2 Betal- och kreditlogik

4. ✅ **Åtgärdad** (`stripe_apply_checkout` → `grant_credits('plan_upgrade')`). ~~**Uppgradering ger inte Pro-krediter direkt.**~~ Webhooken sätter bara `plan = 'pro'`; saldot ändras först vid nästa månadsreset. Den som uppgraderar den 2:a får vänta ~4 veckor på sina 680k krediter. Omvänt behåller den som nedgraderas sitt saldo till nästa reset.
5. ✅ **Åtgärdad** (`invoice.paid` → `renewal`; misslyckad betalning hanteras medvetet via Stripes omförsök + `subscription.deleted`). ~~**Ingen hantering av förnyelse eller misslyckad betalning**~~ (`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`). En prenumeration som hamnar i `past_due`/`unpaid` förblir Pro tills Stripe eventuellt raderar den.
6. ✅ **Åtgärdad för Stripe-prenumeranter** (förnyas på faktureringsdatum; månadsreseten hoppar över dem). Free och Pro utan Stripe följer fortfarande kalendermånaden (UTC), vilket är avsett.
7. ✅ **Åtgärdad** (`effective_plan` i `grant_credits`/reset, `scrape-leads`, `planLimit`). ~~**Pro via värvning (`pro_until`) ignoreras på servern.**~~ `reset_monthly_counters`, `scrape-leads` och `generate-site` tittar bara på `plan`. Klienten (`isProUser`) visar Pro och 100 leads, men servern ger 10 leads och återställer till Free-krediter den 1:a. Värvningsbelöningen blir i praktiken en engångspåfyllning.
8. ✅ **Åtgärdad** (en atomisk `confirm_referral` för både cron och `generate-site`). ~~**Två implementationer av värvningsbekräftelse som beter sig olika:**~~ `process_referrals()` (SQL) har dagstak 10 och använder `greatest(saldo, pro)`; `confirmReferral()` (`_shared/referral.ts`) saknar dagstak, är inte atomisk och *skriver över* saldot med Pro-värdet (kan sänka ett högre saldo).
9. ✅ **Åtgärdad** (reserve → settle/refund, fel loggas; saldot kan bara bli lite negativt om verklig kostnad > estimat, synligt i ledgern). ~~**Avdrag kan misslyckas tyst**~~ – fel från `deduct_credits`/`credit_ledger` sväljs, så en generering kan bli gratis utan spår. Saldot kan också bli negativt (inget golv; förhandskontrollen är bara ett estimat). Negativa *belopp* avvisas sedan migrationen 2026-10-07.
10. ✅ **Estimaten åtgärdade** (klient = server). Kvar: Settings hårdkodar leadsgränsen (10/100) i stället för `PLAN_LIMITS`, och `MONTHLY_ALLOWANCE` i `credits.js` speglar `config` för hand. ~~**Klient och server är redan osynkade:**~~ `credits.js` estimerar ändring med 12 000 output-tokens, servern med 10 000. Settings hårdkodar leadsgränsen (10/100) separat från `PLAN_LIMITS`.
11. ✅ **Accepterat:** klassificeringen (några hundra credits) ingår i samma ledger-rad som genereringen/ändringen och syns i dess tokens.

**Hittat och åtgärdat 2026-10-11:**

17. ✅ **Signup var trasig 2026-06-20 – 2026-10-11** ("Database error saving new user"): `handle_new_user()` anropade `gen_random_bytes` utan schema medan pgcrypto ligger i `extensions`. Rättat i `20261011190000`.
18. ✅ **Chatt-ändringar** skrev om hela sajten (~68k credits, mer än Free-tilldelningen) och klipptes av vid `max_tokens` 10 000 (trasig sajt kunde sparas). Nu SEARCH/REPLACE-block (~13k credits).
19. ✅ **Leads-sökningen** svalde Google Places-fel (fakturering avstängd gav "0 leads") och kom aldrig förbi sida 1 (Google kräver `query` ihop med `pagetoken`).

### 8.3 Övrigt

12. ✅ Löst 2026-10-11 för `generate-site` (live = `config.toml` = true efter deploy). ~~`generate-site` har `verify_jwt = true` i `config.toml` men `false` i live.~~ Funktionen validerar token själv, så det är inte en lucka, men konfigurationen och live skiljer sig. Referral-funktionerna och `edit-element` saknas i `config.toml`.
13. Duplicate-IP-skyddet i `claim-referral` är svagt: `signup_ip` sätts bara för användare som själva blivit värvade via `claim-referral`, och `clientIp()` tar första värdet i `X-Forwarded-For`, som klienten kan påverka. Detsamma påverkar IP-baserad rate limiting.
14. `config.stripe_webhook_secret` lagrar en hemlighet i DB som ingen kod läser.
15. ~~`CLAUDE.md` och arbetsreglerna angav olika rutiner för DB-ändringar.~~ Löst 2026-10-07: migrationsfiler i `supabase/migrations/`, och `schema.sql` är fryst. `CLAUDE.md`, `supabase/README.md` och `schema.sql`-huvudet säger nu samma sak (se avsnitt 2).
16. `.env.example` anger `ANTHROPIC_MODEL=claude-sonnet-4-5`, koden har default `claude-sonnet-4-6`. Sidebar visar `v1.0.1`, `package.json` säger `1.1.0`.
20. **Ny 2026-10-12:** `claim-referral`, `generate-referral-code` och `referral-stats` saknas i `config.toml` men har `verify_jwt = false` live. Nästa deploy av någon av dem slår på gateway-kontrollen (`true`). Troligen ofarligt (de kräver redan en giltig token via `getUser`), men live och repo skiljer sig. Bör antingen läggas in i `config.toml` med önskat värde eller deployas om medvetet.

### 8.4 Öppna fynd från kodgranskningen 2026-10-11 (ej åtgärdade)

Fynd 1 (oändlig loop vid tomt SEARCH-block) är åtgärdat, se avsnitt 4. Kvar (21–23 omkontrollerade i koden 2026-10-12, övriga enligt granskningen):

21. **Misslyckad chatt-ändring återbetalar hela estimatet** (`generate-site`, `refund_credits`) trots att modellen redan förbrukat tokens. Användaren kan alltså få misslyckade ändringar gratis.
22. **`edit-element` har ett fast estimat** (500 in + 3 000 ut = 17 050) oavsett elementets storlek (upp till ~50 000 tecken). Estimatet kan bli för lågt; `settle_credits` drar då mer och saldot kan bli negativt.
23. **Klassificeringen (Haiku) körs före reservationen** i `generate-site`, så en användare med 0 saldo får ändå ett gratis Haiku-anrop per försök (begränsat av rate limit 10/min).
24. **`auth.jsx`:** när en profilladdning avbryts av en nyare (`loadSeq`) kan `loading = false` sättas medan `profile` fortfarande är `null`.
25. **Månadsreset under pågående reservation:** `grant_credits('monthly_reset')` sätter saldot till tilldelningen; när reservationen sedan avslutas justeras saldot relativt det nya värdet, så användaren får fel saldo just den gången.
26. **SEARCH trimmas vid omförsök men inte REPLACE** i `applyEditBlocks`, vilket kan ge felaktiga mellanslag/radbrytningar.
27. **Ingen städning av hängande `reserved`-rader** (se avsnitt 4). 0 sådana rader live 2026-10-12.
28. **`auth.jsx` behåller gammal profil vid fel** – även efter byte av användare kan föregående användares profil visas tills nästa lyckade laddning.
29. `schema.sql`-huvudet har ändrats (bara kommentarer) trots att filen ska vara fryst.
