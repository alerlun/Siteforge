# Credits – analys av två fel

> 2026-10-07. Bygger på `ARKITEKTUR.md`, kodgenomgång och **skrivskyddade** frågor mot live-databasen (`cron.job_run_details`, `pg_proc`, rättigheter, `profiles`, `credit_ledger`). Ingen kod eller data är ändrad.

> **Omverifierad 2026-10-11.** Alla radhänvisningar nedan är kontrollerade mot nuvarande kod (oförändrad sedan 2026-10-07). Live-data är oförändrad: samma tre profiler, samma saldon, inga nya ledger-rader, inga misslyckade cron-körningar. Det enda som ändrats är att **E är åtgärdad** (migrationen är körd och verifierad). Nya iakttagelser är markerade **(ny 2026-10-11)** under D och F.

## Åtgärdslogg (senast 2026-10-11)

| Steg | Vad | Fil | Status |
|---|---|---|---|
| 1 (E) | Lås `profiles` och interna funktioner för klienter | `supabase/migrations/20261007200000_lock_down_profiles_and_credit_functions.sql` | ✅ Körd + verifierad |
| 2a | `grant_credits()`, `effective_plan()`, ledger-kolumner `delta`/`balance_after` | `supabase/migrations/20261011120000_grant_credits.sql` | ✅ Körd + verifierad |
| 2b | Månadsreset via `grant_credits`, räknar `pro_until`, loggar | `supabase/migrations/20261011130000_monthly_reset_via_grant_credits.sql` | ✅ Körd + verifierad (första körning 2026-11-01) |
| 2c-i | `stripe_events` + `stripe_apply_checkout` / `stripe_apply_renewal` (idempotenta) | `supabase/migrations/20261011140000_stripe_event_handlers.sql` | ✅ Körd + verifierad |
| 2c-ii | Webhook: uppgradering fyller på, ny `invoice.paid`, 500 vid DB-fel | `supabase/functions/stripe-webhook/index.ts` | ⏳ Ändrad lokalt, **ej deployad** |
| 2c-iii | Cron-reset hoppar över Stripe-prenumeranter | – | Ej påbörjad (först när 2c-ii fungerar) |
| 2d | Engångskorrigering av de två Pro-kontona till 680 000 | – | Ej påbörjad |
| 3 (D+F) | Atomisk reservation vid avdrag, ledger i samma transaktion | – | Ej påbörjad |
| 4 (B+C) | Frontend: läs om saldo, exakt visning, plan från servern | – | Ej påbörjad |

**Att göra innan nästa steg:**
1. `supabase functions deploy stripe-webhook`
2. I Stripe-dashboarden (live och test): webhook-endpointen ska ta emot `checkout.session.completed`, `invoice.paid` och `customer.subscription.deleted`.
3. Be Claude verifiera efter nästa uppgradering: rad i `stripe_events` och en `plan_upgrade`-rad i `credit_ledger`.

**Beslut 2026-10-11:** ett misslyckat betalningsförsök nedgraderar inte (Stripe gör omförsök och skickar sedan `customer.subscription.deleted`). Vid nedgradering behålls saldot till nästa månadsreset.

**Varning:** `npm run stripe:test` sätter `stripe_mode = test` i live-databasen, så allas uppgraderingar går till Stripes testläge tills `npm run stripe:live` körs.

---

**Problem 1:** Antalet credits i appen stämmer inte med Supabase.
**Problem 2:** Credits fylls inte på varje månad.

---

## Sammanfattning

| # | Grundorsak | Problem | Säkerhet i slutsatsen |
|---|---|---|---|
| A | Månadsjobbet **körs** men sätter saldot efter `plan` *vid körningstillfället*. Byte till Pro mitt i månaden (eller manuell ändring) fyller aldrig på. Inget lyssnar på Stripe-förnyelse. | 2 | Bevisat (cron-logg + funktionsdefinition + radhistorik) |
| B | Frontend håller profilen i React-state som bara läses om vid inloggning, tokenförnyelse och efter egna åtgärder. Ändringar från cron, webhook eller dashboard syns inte förrän sidan laddas om. | 1 | Bevisat i koden |
| C | Visningen avrundar (`68k`) och räknar "tilldelning" på klienten med en annan plan-logik (`isProUser`, hårdkodade tal) än servern. | 1 | Bevisat i koden |
| D | Saldo (`profiles.credit_balance`) och historik (`credit_ledger`) är två separata källor utan koppling. Påfyllningar loggas aldrig och avdragsfel sväljs. De kan inte stämmas av mot varandra. | 1 | Bevisat (kod + data) |
| E | ✅ **Åtgärdad 2026-10-11.** ~~Användare kan själva skriva `credit_balance`/`plan`, och `deduct_credits` kan anropas av vem som helst, även med negativt belopp.~~ | 1, 2 | Verifierat åtgärdad i live-DB |
| F | Kontroll och avdrag är inte atomiska tillsammans. Parallella anrop kan passera kontrollen och driva saldot negativt. Estimatet underskattar dessutom den verkliga kostnaden med upp till 50 %. | 1 | Bevisat (kod + data) |

---

## Bevis från live-databasen

**Cron-jobbet körs och lyckas** (`cron.job_run_details`, jobb `siteforge_reset_monthly`, schema `0 0 1 * *`, `cron.timezone = GMT`, DB-tidszon `UTC`):

| Körning (UTC) | Status | Meddelande |
|---|---|---|
| 2026-07-01 00:00:00 | succeeded | `1 row` |
| 2026-08-01 00:00:00 | succeeded | `1 row` |
| 2026-09-01 00:00:00 | succeeded | `1 row` |
| 2026-10-01 00:00:00 | succeeded | `1 row` |

`1 row` är resultatet av `select reset_monthly_counters()` (en void-rad). Meddelandet säger **inte** hur många profiler som uppdaterades. Live-definitionen av `reset_monthly_counters()` är identisk med `schema.sql:342-363`.

**Profiler nu (2026-10-07):**

| Användare | plan | credit_balance | stripe_customer_id | Rad senast skriven (xmin) |
|---|---|---|---|---|
| f81f804a… | pro | 68 000 | saknas | 33772 |
| dcf7449c… | free | 68 000 | saknas | 32206 |
| 717e4fbe… | pro | 68 000 | saknas | 33771 |

- Båda Pro-kontona har **68 000 = Free-tilldelningen**, inte 680 000.
- Ingen av dem har `stripe_customer_id`. `plan = 'pro'` har alltså **inte** satts av Stripe-webhooken, utan manuellt.
- Free-kontots rad skrevs senast i transaktion 32206, alltså reset-körningen 2026-10-01 00:00 (cron-loggens rader för den körningen har xid 32204–32207).
- Pro-radernas senaste skrivning (xid 33771 och 33772, två separata transaktioner) ligger mellan cron-körningarna **2026-10-06 15:00 (xid 33719) och 16:00 UTC (xid 33786)**, det vill säga 17–18 svensk tid den 6 oktober. Det var alltså efter månadsreseten, och det matchar inte någon kod i appen som skriver `plan`.
- Ingen `credit_ledger`-rad finns efter 2026-06-29, så ingen generering har dragit krediter sedan dess.

**Slutsats för problem 2:** Månadspåfyllningen *körs*. Pro-kontona har ändå Free-saldo, för att `plan` sattes (eller saldot skrevs) manuellt den 6 oktober, och **ingenting fyller på när planen ändras**. Nästa påfyllning blir 2026-11-01. Exakt vilka kolumner som ändrades den 6 oktober går inte att se: `track_commit_timestamp` är av och det finns ingen ändringslogg.

**Bekräftat 2026-10-07:** Kontoägaren ändrade kontona manuellt i Supabase-dashboarden den 6 oktober runt 17–18 svensk tid. Grundorsaken är alltså att en manuell planändring mitt i månaden inte ger någon påfyllning (se A, punkt 4). Pro-kontona behöver en engångskorrigering till 680 000 när `grant_credits` finns på plats.

---

## A. Påfyllning sker bara den 1:a, efter planen just då (problem 2)

**Orsak**
1. `reset_monthly_counters()` sätter saldot utifrån `plan` vid körningen. Den ignorerar `pro_until`.
   `supabase/schema.sql:355-361`
2. Uppgradering via Stripe sätter bara `plan = 'pro'` och rör inte saldot.
   `supabase/functions/stripe-webhook/index.ts:93-105`
3. Webhooken hanterar bara `checkout.session.completed` och `customer.subscription.deleted`. Det finns ingen `invoice.paid` (förnyelse), ingen `invoice.payment_failed` och ingen `customer.subscription.updated`.
   `supabase/functions/stripe-webhook/index.ts:93-119`
4. Det finns ingen trigger på `profiles.plan`. En manuell ändring i dashboarden ger alltså ingen påfyllning (inga triggers på `public`-tabeller, verifierat i live-DB).
5. Pro via värvning (`pro_until`) räknas inte vid reset. Värvaren återgår till Free-saldo den 1:a.
   `schema.sql:358-361` jämfört med `src/lib/auth.jsx:75-80`
6. Reseten loggas inte: ingen rad i `credit_ledger`, inget antal uppdaterade rader. Cron-meddelandet `1 row` är missvisande.
   `schema.sql:194-207`, `342-363`

**Tidszoner och datum**
- Cron körs 00:00 **UTC** den 1:a (`cron.timezone = GMT`). Det motsvarar 02:00 svensk sommartid och 01:00 vintertid.
- Settings visar "Credits reset on …" via `nextResetDate()`, som räknar i **användarens lokala tid** och formaterar med `en-US`.
  `src/lib/utils.js:34-38`
  För en användare väster om UTC (t.ex. USA) sker reseten kvällen innan det datum som visas. I Sverige stämmer datumet.
- Påfyllningen följer kalendermånaden, inte Stripe-faktureringsperioden. Den som betalar den 20:e får Pro-krediter först den 1:a.

**Föreslagen lösning**
1. En DB-funktion `grant_credits(user_id, reason)` som i **en transaktion** sätter saldot till rätt tilldelning *och* skriver en ledger-rad (`action_type = 'monthly_reset' | 'plan_upgrade' | 'renewal' | 'referral_bonus'`).
2. Webhook:
   - `checkout.session.completed` → `plan = 'pro'` + `grant_credits(..., 'plan_upgrade')`.
   - Ny hantering av `invoice.paid` (där `billing_reason = 'subscription_cycle'`) → `grant_credits(..., 'renewal')`.
   - `invoice.payment_failed`/`customer.subscription.updated` (status `past_due`/`unpaid`/`canceled`) → nedgradering.
3. Cron den 1:a sköter då bara **Free**-användare, plus Pro utan Stripe (manuella/värvade). Använd en gemensam definition av "effektiv plan" som tar med `pro_until`.
4. Logga reseten: `raise log` med antal rader, eller ledger-rader per användare.
5. Om manuell Pro-tilldelning ska vara ett normalt arbetssätt: en trigger på `profiles` (när `plan` ändras från `free` till `pro`) som anropar `grant_credits`. Alternativt dokumentera att man ska köra `grant_credits` efter en manuell ändring.
6. Visa reset-datum i UTC eller "1:a varje månad, 02:00 svensk tid" i stället för lokalt beräknat datum.

---

## B. Frontend visar inaktuellt state (problem 1)

**Orsak**
- Profilen (inklusive `credit_balance`) läses rätt: tabell `profiles`, kolumn `credit_balance`, `select *`.
  `src/lib/auth.jsx:17-33`
- Den läses bara om:
  - vid start och vid auth-händelser (inloggning, tokenförnyelse ungefär varje timme) – `src/lib/auth.jsx:35-52`
  - efter lyckad generering – `src/pages/Chat.jsx:244`
  - efter lyckad elementändring – `src/pages/Editor.jsx:271`
  - efter leads-sökning – `src/pages/Leads.jsx:90`
  - 1,5 s efter Stripe-retur – `src/pages/Settings.jsx:19-27`
- Den läses **inte** om vid fokus/flikbyte, vid navigering mellan sidor, eller när DB ändras utifrån (cron, webhook, dashboard). Det finns ingen Realtime-prenumeration.
- **Felvägen läser inte om profilen.** Om SSE-strömmen bryts på klienten ("Stream ended without result", `src/lib/api.js:85`) efter att servern redan dragit krediter (`generate-site/index.ts:589`) visas det gamla saldot. Se catch-grenen i `src/pages/Chat.jsx:252-259` (och `src/pages/Editor.jsx:278`).
- Två parallella `loadProfile`-anrop vid start (`getSession` + `onAuthStateChange`, `auth.jsx:38-47`) kan landa i fel ordning, så att ett äldre svar skriver över ett nyare. Det är en liten risk.

**Konsekvens:** När du ändrade värden i Supabase den 6 oktober, eller när cron körde den 1:a, visade en redan öppen flik det gamla värdet fram till nästa omladdning eller tokenförnyelse.

**Föreslagen lösning**
1. Läs om profilen vid `visibilitychange`/`focus` och vid route-byte inom `/app`. Det är billigt: en rad, med RLS.
2. Alternativt: Supabase Realtime på den egna `profiles`-raden. Då måste tabellen läggas till i publikationen `supabase_realtime`; CSP tillåter redan `wss://*.supabase.co`.
3. Anropa `refreshProfile()` även i `catch`/`finally` i `Chat.jsx` och `Editor.jsx`.
4. Ignorera inaktuella svar i `loadProfile`, t.ex. med en räknare per anrop.

---

## C. Visningen avrundar och räknar annorlunda än servern (problem 1)

**Orsak**
1. `formatCredits` avrundar till hela tusental (`toFixed(0)`). 67 600 visas som "68k" och 68 499 också som "68k". Saldot ser alltså oförändrat ut efter små avdrag.
   `src/lib/credits.js:26-31`
2. Tilldelningen ("x / 680k", förbrukningsstapeln) tas från hårdkodade `MONTHLY_ALLOWANCE` och klientens `isProUser()`, som räknar `pro_until` som Pro. Servern gör inte det.
   `src/lib/credits.js:9-12`, `src/lib/auth.jsx:75-80`, `src/pages/Chat.jsx:52-56`, `src/pages/Settings.jsx:29-34, 150-155`
   Med dagens data visar Settings för Pro-kontona "använt 612k av 680k" fast inget har förbrukats.
3. Klientens estimat skiljer sig från serverns: en ändring räknas som 12 000 output-tokens på klienten men 10 000 på servern. Knappen kan alltså spärras eller släppas annorlunda än servern bedömer.
   `src/lib/credits.js:17` jämfört med `supabase/functions/generate-site/index.ts:66-70`
4. `credit_ledger`-tabellen i Settings visar bara avdrag. Påfyllningar och manuella ändringar syns inte, så "historiken" summerar inte till saldot.
   `src/pages/Settings.jsx:44-56`

**Föreslagen lösning**
1. Visa exakt saldo, t.ex. `67 600` med tusentalsavgränsare, åtminstone i Settings och i tooltip.
2. Hämta tilldelning och effektiv plan från servern (en vy eller ett fält som returneras av en edge function) i stället för hårdkodade tal och `isProUser`.
3. Ta bort den duplicerade sats-/tilldelningslistan i `credits.js`, eller generera den från `config`.

---

## D. Saldo och ledger glider isär (problem 1)

**Orsak**
- Saldot lagras i `profiles.credit_balance`. Historiken lagras i `credit_ledger`. De skrivs i **två separata anrop** och fel sväljs i båda:
  - `generate-site/index.ts:83-91` (`.then(null, () => {})`)
  - `edit-element/index.ts:130-138`
  Om RPC:n misslyckas finns en ledger-rad utan avdrag. Om insert misslyckas finns ett avdrag utan ledger-rad.
- Saldot ändras även utan ledger-rad på flera ställen:
  - månadsreset – `schema.sql:355-361`
  - signup – `schema.sql:454-455`
  - värvningsbonus – `schema.sql:529-535` och `supabase/functions/_shared/referral.ts:77-83` (den senare **skriver över** saldot och kan alltså sänka det)
  - manuella ändringar och klientens egna skrivningar (se E)
- Data bekräftar: f81f804a har ledger-summa 96 947 (juni) men saldo 68 000, och det finns ingen post som förklarar skillnaden.
- **(ny 2026-10-11) Ledger-raden går inte att räkna om till `credits_charged`.** `credits_charged` omfattar cache-tokens (`cache_creation_input_tokens`/`cache_read_input_tokens`) och klassificeringsanropet (Haiku), men tabellen sparar bara `input_tokens` och `output_tokens`. Exempel från live-data:

  | Rad | input | output | (in + out·5)·1,1 | `credits_charged` |
  |---|---|---|---|---|
  | f81f804a 2026-06-20 17:17 | 235 | 8 169 | 45 188 | 49 839 |
  | f81f804a 2026-06-20 19:00 | 237 | 7 648 | 42 325 | 47 108 |
  | 717e4fbe 2026-06-29 19:04 | 216 | 11 604 | 64 060 | 68 843 |

  Ledgern kan alltså inte användas för att kontrollera att rätt belopp dragits. Formeln: `generate-site/index.ts` `computeCredits`. Kolumnerna: `schema.sql:194-207`.
  Lösning: spara även `cache_write_tokens`, `cache_read_tokens` och klassificeringens tokens (eller en `delta` plus rå `usage` som jsonb).

**Föreslagen lösning**
- Låt **all** ändring av saldot gå via DB-funktioner som skriver ledger-raden i samma transaktion. Ledgern får ett tecken (positiv = påfyllning, negativ = avdrag) eller en kolumn `delta`.
- Då gäller `credit_balance = summa(delta)` sedan senaste reset, och det kan kontrolleras med en enkel fråga.
- Ta bort sväljandet av fel. Ett misslyckat avdrag ska åtminstone loggas (`console.error`).

---

## E. Klienten kan manipulera credits (problem 1 och 2)

> ✅ **Åtgärdad.** Migrationen `supabase/migrations/20261007200000_lock_down_profiles_and_credit_functions.sql` är körd mot live-DB. Verifierat 2026-10-11: `anon`/`authenticated` har bara SELECT på `profiles`, ingen INSERT på `credit_ledger`, och ingen EXECUTE på `deduct_credits`, `reset_monthly_counters`, `process_referrals`, `check_rate_limit` och `purge_rate_limits`. `service_role` har kvar EXECUTE på `deduct_credits` och `check_rate_limit`. `deduct_credits` avvisar negativa belopp. Klienten skriver aldrig till `profiles` (bara `select` i `src/lib/auth.jsx:22-26`), så inget i appen påverkas.
> Kvar, låg risk: `anon`/`authenticated` har fortfarande tabellrättigheter på `config`, `rate_limits` och `referral_activations`; bara RLS stoppar dem (se `ARKITEKTUR.md` 8.1 punkt 3b).

Ursprunglig analys (före åtgärd):

**Orsak** (verifierat i live-DB med `has_column_privilege` / `has_function_privilege`):
- Policyn `profiles self update` (`schema.sql:101-103`) saknar kolumnbegränsning, och `authenticated` har UPDATE på bl.a. `credit_balance`, `plan`, `pro_until`. Vem som helst kan sätta sitt eget saldo och sin egen plan från webbläsarkonsolen. Appen själv uppdaterar aldrig `profiles` från klienten (sökning i `src/` ger inga träffar), så rättigheten behövs inte.
- `deduct_credits(uuid, bigint)` (`schema.sql:321-339`) är SECURITY DEFINER och körbar av `anon` och `authenticated`. Den saknar kontroll av anroparen och av beloppets tecken. Man kan dra krediter från andra användare eller ge sig själv krediter med ett negativt belopp.
- `reset_monthly_counters()` är också körbar av `anon`. Vem som helst kan återställa allas saldon när som helst.

**Föreslagen lösning** (migrationsfil för din granskning):
```sql
-- profiles: klienten behöver bara läsa sin rad
drop policy if exists "profiles self update" on public.profiles;
drop policy if exists "profiles self insert" on public.profiles;   -- raden skapas av handle_new_user
revoke insert, update, delete on public.profiles from anon, authenticated;

-- interna funktioner: bara service_role / cron
revoke execute on function public.deduct_credits(uuid, bigint)   from public, anon, authenticated;
revoke execute on function public.reset_monthly_counters()      from public, anon, authenticated;
revoke execute on function public.process_referrals()           from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text,int,int) from public, anon, authenticated;
grant  execute on function public.deduct_credits(uuid, bigint)   to service_role;
grant  execute on function public.check_rate_limit(text,int,int) to service_role;
```
Lägg dessutom till `if p_credits <= 0 then raise exception` i avdragsfunktionen.

---

## F. Kontroll och avdrag är inte atomiska tillsammans (problem 1)

**Orsak**
- Själva avdraget är atomiskt: `update … set credit_balance = credit_balance - x` i en RPC (`schema.sql:333-336`). Det är bra.
- Men saldokontrollen görs **före** AI-anropet, på ett tidigare läst värde (`generate-site/index.ts:448, 468-476`; `edit-element/index.ts:113-118`). Avdraget görs 30–90 s senare (`generate-site/index.ts:589`). Det finns ingen reservation. Upp till 10 samtidiga anrop per minut (rate limit) kan alla passera kontrollen, och saldot blir negativt. Funktionen tillåter uttryckligen negativt saldo (kommentaren på `schema.sql:320`).
- Om saldot saknas (`null`) antar `generate-site` full tilldelning (`index.ts:468-470`), medan `edit-element` antar 0 (`index.ts:114`). Samma användare kan alltså få olika svar från de två funktionerna.
- **(ny 2026-10-11) Estimatet underskattar.** Servern estimerar en ny sajt till 1 200 in / 8 000 ut ≈ 45 320 credits (`generate-site/index.ts:66-70`), utan cache-tokens och klassificering. Verklig kostnad i live-data var 47 108–68 843, alltså upp till 52 % mer. 717e4fbe fick en generering för 68 843 credits, vilket är mer än hela Free-tilldelningen (68 000). Saldot kan alltså bli negativt även vid **ett enda** anrop, och en Free-användare räcker för ungefär en sajt i månaden.
- `generations_used` räknas upp med läs-ändra-skriv (`generate-site/index.ts:587`). Det kan tappa uppräkningar vid samtidiga anrop, men påverkar bara statistik.

**Föreslagen lösning**
- Reservera estimatet atomiskt före AI-anropet: `update profiles set credit_balance = credit_balance - :est where id = :uid and credit_balance >= :est returning credit_balance`. Om ingen rad uppdateras → 402.
- Efter anropet: justera med (faktisk kostnad − estimat), och skriv ledger-raden i samma funktion. Vid fel: återbetala reservationen.
- Behandla saknat saldo lika i båda funktionerna (0).

---

## Föreslagen ordning (efter ditt OK)

1. ✅ **E** – Migration som stänger skrivrättigheter och funktionsanrop. Körd och verifierad 2026-10-11.
2. **A** – `grant_credits` + ledger-loggning, webhook för `checkout.session.completed`/`invoice.paid`, cron som tar hänsyn till `pro_until`. Engångskorrigering av de två Pro-kontona efter att du bekräftat vad som hände den 6 oktober.
3. **D + F** – Avdrag med reservation, och ledger skriven i samma transaktion.
4. **B + C** – Frontend: läs om profilen vid fokus/route-byte och vid fel, exakt visning, tilldelning från servern.

Varje steg blir en separat, avgränsad ändring med migrationsfil i `supabase/migrations/` (beslutad rutin, se `ARKITEKTUR.md` avsnitt 2). Radhänvisningar till `schema.sql` avser den frysta versionen med 4 rader långt huvud.
