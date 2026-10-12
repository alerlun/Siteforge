# Sessionslogg 2026-10-12: säkerhets- och kvalitetsgranskning av SiteForge

Den här sessionen granskade hela appen (`AUDIT-APP.md`) och åtgärdade fynden i tur och ordning: Hög, Medel och sist Låg. Varje fynd har en egen commit och en statusrad i `AUDIT-APP.md`. Den här filen sammanfattar vad som gjordes, i vilken ordning, hur det verifierades och vad som återstår.

Live: https://siteforge-vert.vercel.app · Supabase-projekt `gwvgrryxkwfrybcpyvqv`

---

## 1. Översikt

| Del | Resultat | PR |
|---|---|---|
| Förarbete | `ARKITEKTUR.md` omverifierad, `verify_jwt = true` för edit-element och värvningsfunktionerna | (före PR #3) |
| Granskning | `AUDIT-APP.md`: 0 kritiska, 6 Hög, 12 Medel, 23 Låg | #3 |
| Hög H1–H6 | Alla åtgärdade och live | #3 |
| Medel M1–M12 | Alla åtgärdade och live (M4 utan kodändring, M11 delvis) | #4, #5 |
| Editor-uppföljning | Versionshistorik i DB, History-meny, Back-bugg | #5 |
| Låg, frontend | L11–L14, L16–L19, L21, L23 + Privacy-text | #6 |
| Låg, backend/DB/prestanda | L1–L10, L15, L20, L22 | #7 |

Allt är mergat till `main` (senast `483a5b1`) och deployat. 11 migrationer kördes och samtliga tio Edge Functions deployades om.

---

## 2. Hög (H1–H6), PR #3

| # | Problem | Åtgärd |
|---|---|---|
| H1 | `scrape-leads` kunde göra obegränsat många Google Place Details-anrop | Minst 1 lead av kvoten dras per 5 undersökta företag (`EXAMINED_PER_LEAD`); Leads visar kvoten |
| H2 | Kvoten kontrollerades inte atomärt, så samtidiga sökningar kunde gå över gränsen | Migration `20261012130000`: `reserve_leads`/`release_leads`; kvoten reserveras före Google-anropen och lämnas tillbaka på alla utgångar |
| H3 | Flera prenumerationer och Stripe-kunder per konto | `create-checkout` svarar 409 `already_subscribed` och skapar kunden server-side med idempotensnyckel; webhooken nedgraderar bara rätt prenumeration |
| H4 | Estimaten var för låga och negativa saldon försvann vid månadsreset | Storleksbaserade estimat (server och klient i synk), historik max 4000 tecken; migration `20261012140000`: skuld följer med vid reset |
| H5 | Lösenordsåterställningen saknade steget "välj nytt lösenord" | Ny sida `/reset-password`, "Forgot password?" på Login; redirect-URL tillagd i Supabase |
| H6 | Det gick inte att radera sitt konto | Ny Edge Function `delete-account`: säger upp Stripe först och kräver att man skriver DELETE |

---

## 3. Medel (M1–M12), PR #4 och #5

| # | Problem | Åtgärd |
|---|---|---|
| M1 | "Fullscreen" körde genererad HTML i appens origin, så den kunde stjäla sessionen | Helskärmsöverlägg med samma sandlådade iframe som förhandsvisningen |
| M2 | Webhooken gav Pro innan betalningen gått igenom | Uppgradering bara vid `payment_status` `paid`/`no_payment_required`, plus `checkout.session.async_payment_succeeded` |
| M3 | Obegränsat antal gratiskonton | Cloudflare Turnstile-captcha på signup, login och reset; "Confirm email" påslaget |
| M4 | IP lästes från `X-Forwarded-For` | Testat live: Supabase-gatewayn skriver över headern, så den går inte att förfalska. Bara en kommentar i `guards.ts` |
| M5 | Editorn visade "Saved" även när sparningen misslyckades | Felkontroll, "Not saved" med "Retry", varning när man lämnar sidan |
| M6 | Ångra, gör om och återställ sparades aldrig | Sparar den visade versionen (fördröjt 600 ms); historiken i DB, se 3.1 |
| M7 | "Manage Billing" gav alltid fel för Pro via värvning | Knappen visas bara med Stripe-prenumeration; värvnings-Pro visar slutdatum och Upgrade |
| M8 | Stats räknade varje sajtversion som en egen sajt | En sajt per chatt-session |
| M9 | Samma företag kunde sparas som lead flera gånger | Migration `20261012150000`: `leads.place_id` + unikt index; kända företag hoppas över före Details-anropet |
| M10 | Det gick inte att byta chatt på mobil | Fliken "Chats" på mobil |
| M11 | Google Places-data och tredje persons uppgifter | Radering av leads (en eller flera) + avsnitt i Privacy. **Kvar:** juridisk bedömning av Googles cachevillkor |
| M12 | GA laddades före samtycke, och "Accept" gav annonssamtycke | GA laddas först efter Accept, bara `analytics_storage`, ingen query-sträng |

### 3.1 Editor-uppföljning (rapporterad av användaren efter test live)

- **History-menyn** klipptes av och scrollade inne i headern. Den är nu `fixed` under knappen och stängs vid klick utanför.
- **Back gav en vit sida** ("It may have been moved, edited, or deleted"). Orsaken var att varje byte av iframens `src` lade ett steg i webbläsarens historik, som pekade på en redan återkallad `blob:`-URL. Iframen skapas nu om per version (`key={previewUrl}`), både i Editor och Chat.
- **Historiken försvann** när man lämnade Editorn. Migration `20261012160000` lägger till tabellen `site_versions` (RLS per användare, ingen UPDATE). Varje AI-ändring sparas som en version, och originalet sparas vid första ändringen.

---

## 4. Låg (L1–L23), PR #6 och #7

| # | Åtgärd |
|---|---|
| L1 | En misslyckad chatt-ändring (`edit_failed`) debiteras sin faktiska tokenkostnad, högst estimatet (beslut av användaren). Andra fel återbetalas helt |
| L2 | Saldokontroll före Haiku-klassificeringen (402 direkt) |
| L3 | Migration `20261012180000`: månadsreset drar av öppna reservationer |
| L4 | Migration `20261012170000`: `refund_stale_reservations()` via pg_cron var 10:e minut |
| L5 | Webhooken prövar båda Stripe-lägenas hemligheter; händelser från det inaktiva läget kvitteras men tillämpas aldrig |
| L6 | Alla `v1`-signaturer jämförs |
| L7 | Ingen IP-gräns på webhooken |
| L8 | Stripes retur-URL:er tas från en tillåtelselista (`_shared/app-url.ts`) |
| L9 | Interna felmeddelanden loggas och skickas inte till klienten |
| L10 | Värvningsfunktionerna har rate limit (20/min) och returnerar fel som JSON |
| L11 | Editorn tar bara emot meddelanden från sin egen iframe |
| L12 | AI-svar skarvas in med en funktionsersättare, så `$&` med flera förstör inte HTML:en |
| L13 | CSV-exporten skyddas mot formelinjektion (telefonnummer lämnas orörda) |
| L14 | Formulären kräver lösenord på minst 8 tecken; samma gräns ska sättas i Supabase (se avsnitt 7). **Kvar:** skyddet mot läckta lösenord kräver Supabase Pro |
| L15 | Migration `20261012190000`: `search_path` på `purge_rate_limits`, ingen EXECUTE för klienter på `handle_new_user` |
| L16 | Profilen nollställs vid byte av användare, och ett misslyckat hämtförsök görs om en gång |
| L17 | SSE avbryts efter 45 s utan data, med ett tydligt fel |
| L18 | Fel vid sparning av chattmeddelanden, radering av chatt och statusbyte i Leads visas (statusbytet återställs) |
| L19 | Radering av chatt kräver bekräftelse; knappen syns på mobil och har `aria-label` |
| L20 | Leads hämtas 100 åt gången med "Load more". **Kvar vid stora volymer:** aggregering i SQL för Stats, och CSV-exporten får högst 1000 rader |
| L21 | SSE-loggning bara i utvecklingsläge |
| L22 | Landing och Chat laddas vid behov (huvudbunten 430 → 407 kB) |
| L23 | Chatten skickar bara de 40 senaste meddelandena, så långa chattar fortsätter fungera |

Utöver fynden rättades Privacy-texten om GA så att den beskriver hur det faktiskt fungerar nu.

---

## 5. Migrationer som kördes (i ordning)

| Fil | Innehåll |
|---|---|
| `20261012130000_reserve_release_leads.sql` | H2: atomär leadskvot |
| `20261012140000_carry_negative_balance.sql` | H4: skuld följer med vid reset |
| `20261012150000_leads_place_id.sql` | M9: `place_id` och unikt index |
| `20261012160000_site_versions.sql` | Editorns versionshistorik |
| `20261012170000_refund_stale_reservations.sql` | L4: återbetalning av hängande reservationer, pg_cron |
| `20261012180000_grant_credits_open_reservations.sql` | L3: reset tar hänsyn till öppna reservationer |
| `20261012190000_advisor_fixes.sql` | L15: rådgivarens varningar |

Alla granskades av användaren innan de kördes med `npx supabase db push`, och verifierades efteråt med SQL (behörigheter, RLS-regler, cron-jobb).

## 6. Edge Functions, versioner efter sessionen

| Funktion | Version |
|---|---|
| generate-site | 45 |
| scrape-leads | 31 |
| stripe-webhook | 27 (`verify_jwt = false`) |
| create-checkout | 25 |
| create-portal | 24 |
| edit-element | 12 |
| referral-stats | 6 |
| claim-referral | 5 |
| generate-referral-code | 5 |
| delete-account | 2 (ny i sessionen) |

---

## 7. Inställningar utanför koden

| Var | Inställning | Status |
|---|---|---|
| Supabase Auth | Redirect URL `<origin>/reset-password` | Gjort |
| Supabase Auth | Captcha (Turnstile, secret key) | Gjort, verifierat (`captcha_failed` utan token) |
| Supabase Auth | Confirm email | Gjort |
| Supabase Auth | Minimum password length 8 | Användarens uppgift (instruktion given, ej bekräftad) |
| Cloudflare | Turnstile-widget för domänen | Gjort |
| Vercel | `VITE_TURNSTILE_SITE_KEY` | Gjort, verifierat i live-bunten |
| Vercel | `VITE_GA_MEASUREMENT_ID` = `G-WJ8JEY6X62` | Gjort, verifierat: inga anrop före Accept, `gcs=G101` efter |
| Stripe | Webhook-händelsen `checkout.session.async_payment_succeeded` (test och live) | Användarens uppgift (ej verifierad härifrån) |
| Google Cloud | Dagsgräns för Place Details + budgetlarm | Användarens uppgift (ej verifierad härifrån) |
| Supabase | `ALLOWED_ORIGINS` (för betalning från preview-domäner) | Valfritt, ej satt |

---

## 8. Verifiering

- `npm run build` efter varje frontendändring; `npx --yes deno check` efter varje ändring i en funktion. De sex gamla typfelen i `_shared/ratelimit.ts` och `generate-site` (`getCreditRates`) finns kvar och är inte orsakade av sessionen.
- Live-kontroller med headless Chromium:
  - captcha på `/login` och `/signup`
  - `/reset-password`
  - Privacy
  - GA före och efter samtycke
  - CSP utan blockeringar
- API-kontroller utan inloggning: 401 på skyddade funktioner, 400 `invalid signature` på webhooken.
- M4 verifierades genom att skicka anrop med förfalskad `X-Forwarded-For` och läsa raden i `rate_limits`.
- Användaren testade Editor, Leads, Stats och mobil-Chat live efter merge.
- **Inte testat end-to-end:** riktiga Stripe-betalningar (inklusive SEPA/Klarna), värvningsflödet och månadsreset med öppna reservationer.

---

## 9. Kvar att göra

1. **Juridik (M11):** granska Googles villkor för cachning av Places-data och Privacy-texten om lead-data. Alternativ: rensa detaljer efter 30 dagar och behålla `place_id`.
2. **Supabase Pro (L14):** slå på skyddet mot läckta lösenord om ni uppgraderar.
3. **Stripe och Google Cloud:** bekräfta att punkterna i avsnitt 7 är gjorda.
4. **Testkonto:** skapa ett nytt konto och kontrollera att det får credits, för att bekräfta att L15 inte påverkade `handle_new_user`.
5. **Vid växande volymer (L20):** aggregering i SQL för Stats och paginerad CSV-export (fler än 1000 leads).
6. **Gamla typfel:** de sex `deno check`-felen i `ratelimit.ts` och `generate-site`.
7. **Småsaker från `ARKITEKTUR.md` 8** (oförändrade):
   - Settings leadsgräns hårdkodad
   - `MONTHLY_ALLOWANCE` en manuell kopia
   - oanvänd `config.stripe_webhook_secret`
   - versionsnummer i Sidebar

---

## 10. Lärdomar

- **Migration före funktion.** M9 deployades före sin migration, och lead-sökningen var trasig i några minuter. Kör alltid `db push` innan funktioner som använder nya kolumner deployas.
- **Captcha i rätt ordning.** Site key i Vercel → deploy → först därefter captcha i Supabase. Annars slutar e-postinloggningen fungera.
- **Vercel kan missa en push.** Under en Vercel-incident deployades inte PR #3 automatiskt. Kontrollera alltid Deployments efter en merge.
- **`blob:`-URL i iframe.** Att byta `src` lägger till steg i webbläsarens historik. Använd `key` för att skapa om iframen.
- **Deploy från agenten.** Claude Codes behörighetsklassificerare nekade ibland `functions deploy` och `git push`. Användaren körde då kommandona själv med `!`.
