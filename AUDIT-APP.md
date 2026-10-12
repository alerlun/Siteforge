# SiteForge – Granskning av appen

> Utförd 2026-10-12 på branchen `audit-fixes` (423fe49). Ingen kod ändrad.
> Underlag: all kod i `src/`, `supabase/functions/`, `supabase/migrations/`, `scripts/`, `vercel.json`, `ARKITEKTUR.md`, samt **skrivskyddade** kontroller av live-databasen (policies, rättigheter, funktioner, cron) och Supabase säkerhetsrådgivare (`get_advisors`).
> Fynd märkta *(kontrollerat)* är verifierade i kod eller live. Fynd märkta *(trolig)* beror på yttre faktorer (t.ex. Stripe-inställningar) som inte gick att kontrollera härifrån.
> Sedan tidigare kända och fortfarande öppna punkter från `ARKITEKTUR.md` 8.3–8.4 finns med här, med hänvisning.

## Sammanfattning

**Inga kritiska fynd.** Grundskyddet håller: service role-nyckeln finns inte i frontend eller i git-historiken, RLS är på för alla tabeller, interna DB-funktioner kan bara köras av `service_role`, Stripe-signaturen verifieras, och AI-förhandsvisningen körs i en sandlåda utan `allow-same-origin`.

De största riskerna gäller **pengar** (Google Places-kostnad utan tak, credits som kan överdras, dubbla prenumerationer), **två trasiga flöden** (lösenordsåterställning, kontoradering) och **en XSS-väg** via helskärmsknappen.

| # | Allvar | Område | Fynd |
|---|---|---|---|
| H1 | ✅ Hög | Pengar | Leads-sökning kan köra obegränsat många Google Places-anrop |
| H2 | ✅ Hög | Pengar/Bugg | `leads_used` uppdateras inte atomiskt – parallella sökningar kringgår gränsen |
| H3 | ✅ Hög | Pengar | Ingen spärr mot dubbla checkouts → två prenumerationer, en kan inte sägas upp i appen |
| H4 | ✅ Hög | Pengar | Klienten styr indatastorleken – verklig kostnad kan bli flera gånger estimatet, skulden nollas den 1:a |
| H5 | ✅ Hög | Bugg | Lösenordsåterställning saknar steget "välj nytt lösenord" |
| H6 | ✅ Hög | Dataskydd | Det går inte att radera sitt konto, trots att integritetspolicyn säger det |
| M1 | Medel | Säkerhet | "Fullscreen" kör genererad HTML i appens origin (åtkomst till inloggningstoken) |
| M2 | Medel | Pengar | Webhooken ger Pro utan att kontrollera `payment_status` *(trolig)* |
| M3 | Medel | Pengar | Obegränsat antal gratiskonton à 68 000 credits |
| M4 | Medel | Säkerhet | IP-adress läses från `X-Forwarded-For` → IP-rate-limit och värvnings-IP-skydd kan kringgås |
| M5 | Medel | Bugg | Editor visar "Saved" även när sparningen misslyckas |
| M6 | Medel | Bugg | Ångra/gör om/återställ version i Editor sparas aldrig |
| M7 | Medel | Bugg | Pro via värvning visar "Manage Billing", som alltid ger fel; uppgradering omöjlig |
| M8 | Medel | Bugg | Stats räknar varje sajtversion som en egen sajt |
| M9 | Medel | Bugg | Samma företag kan sparas som lead flera gånger och dra av kvoten |
| M10 | Medel | UX | På mobil går det inte att byta chatt eller starta en ny |
| M11 | Medel | Dataskydd | Lagring av Google Places-data och tredje persons uppgifter |
| M12 | Medel | Dataskydd | Google Analytics laddas före samtycke; "Accept" ger även annonssamtycke |
| L1–L22 | Låg | Diverse | Se avsnitt Låg |

---

## Hög

### H1. ✅ Leads-sökning kan köra obegränsat många Google Places-anrop *(kontrollerat)*
> **Åtgärdat 2026-10-12** (**deployad 2026-10-12**, `scrape-leads` v29): varje 5 undersökta företag drar minst 1 lead av kvoten (`EXAMINED_PER_LEAD = 5`; kvot = max(sparade, ceil(undersökta/5))). Antalet Details-anrop per konto och månad blir då högst 5 × leadsgränsen (Free 50, Pro 500). Leads-sidan visar när kvoten dragits för skannade företag. Rekommenderat utöver koden: dagsgräns för Place Details och budgetlarm i Google Cloud.
- **Område:** Pengar / Säkerhet (kostnadsmissbruk)
- **Fil:** `supabase/functions/scrape-leads/index.ts:84-86`, `:138-155`, `:181-184`
- **Problem:** Kvoten (`leads_used`) räknar bara **sparade** leads. Med standardfiltret "Without website only" hoppas företag med hemsida över. De kostar ändå ett Place Details-anrop var, men räknas inte. En gratisanvändare med 10 leads kvar får `examineCap = 50`. Söker hen på en kategori där alla har hemsida, t.ex. "hotell i Stockholm", blir det 50 Details-anrop och 0 leads. Det kan upprepas 20 gånger/minut (rate limit) utan att kvoten minskar, alltså upp till ~1 000 Details-anrop/minut per konto. Place Details med Contact- och Atmosphere-fält kostar ungefär 0,02–0,03 USD/st. Det kan bli flera hundra dollar per timme från ett enda gratiskonto.
- **Förslag:** Räkna *undersökta* företag mot en separat månadskvot, eller dra av kvoten per Details-anrop. Sätt ett hårt dagstak per användare och ett globalt dagstak, och lägg in budgetlarm och kvotgräns i Google Cloud (Quotas → Place Details per dag). Sänk `examineCap` för gratiskonton.

### H2. ✅ `leads_used` uppdateras inte atomiskt *(kontrollerat)*
> **Åtgärdat 2026-10-12** (**deployad 2026-10-12**: migration `20261012130000` körd och verifierad, `scrape-leads` v29): ny `reserve_leads(user, antal, gräns)` låser profilraden och tar kvoten före Google-anropen; `release_leads` ger tillbaka oanvänd del på alla utgångar (lyckad sökning, Places-fel, DB-fel, undantag). Gränsen skickas från `PLAN_LIMITS` så den finns kvar på ett ställe.
- **Område:** Pengar / Race condition
- **Fil:** `supabase/functions/scrape-leads/index.ts:60-84` (läser) och `:181-184` (skriver `profile.leads_used + inserted.length`)
- **Problem:** Saldot läses i början och skrivs över i slutet, och en sökning tar flera sekunder (bland annat 2,2 s väntan per sida). Två parallella anrop ser båda "10 kvar", sparar 10 leads var och skriver båda `leads_used = 10`. Med 20 parallella anrop får en gratisanvändare ~200 leads, och Google-kostnaden blir 20×.
- **Förslag:** Reservera kvoten atomiskt före Google-anropen, på samma sätt som `reserve_credits`. En DB-funktion `reserve_leads(user, n)` gör `update ... set leads_used = leads_used + n where leads_used + n <= limit returning ...`, och oanvänd del ges tillbaka efteråt. Alternativt `leads_used = leads_used + x` i SQL, kombinerat med ett lås per användare.

### H3. ✅ Ingen spärr mot dubbla checkouts *(kontrollerat i kod)*
> **Åtgärdat 2026-10-12** (`create-checkout` **deployad 2026-10-12** (v24); `stripe-webhook` **deployad 2026-10-12** (v25); inte testat mot Stripe): (1) `create-checkout` svarar 409 `already_subscribed` om kontot redan har en Stripe-prenumeration; Settings visar då ett tydligt meddelande. (2) Stripe-kunden skapas server-side (med idempotensnyckel per användare) och sparas innan sessionen, så alla checkouts använder samma kund och syns i Billing Portal. (3) `customer.subscription.deleted` nedgraderar bara om prenumerations-id:t matchar profilen. Live hade 0 Stripe-kunder, så inget behöver städas. Kvar som möjlig risk: två sessioner som öppnats innan den första betalats kan fortfarande båda betalas; de hamnar nu på samma kund och kan sägas upp i portalen. Stripe kan blockera det helt med inställningen för att begränsa kunder till en prenumeration, om den finns för ert konto.
- **Område:** Pengar (betala två gånger)
- **Fil:** `supabase/functions/create-checkout/index.ts:35-48`, `supabase/functions/stripe-webhook/index.ts:97-109`, `:121-135`, migration `20261011140000` (`stripe_apply_checkout`)
- **Problem:**
  1. `create-checkout` kontrollerar inte om användaren redan är Pro eller har en aktiv prenumeration. UI:t döljer knappen för Pro-användare, men två flikar eller en dubbelklick innan webhooken hunnit fram ger två Checkout-sessioner. Båda kan betalas, och då finns två prenumerationer.
  2. För nya kunder skickas `customer_email` i stället för `customer`. Stripe skapar då **två olika kunder**. `stripe_apply_checkout` skriver över `stripe_customer_id`/`stripe_subscription_id` med den senaste. Den första prenumerationen dras varje månad men syns inte i Billing Portal, som bara visar den sparade kunden. Användaren kan alltså inte säga upp den i appen. Förnyelser av den ignoreras (`stripe_apply_renewal` hittar ingen profil), så användaren betalar utan att få något.
  3. `customer.subscription.deleted` nedgraderar på kund-id utan att jämföra prenumerations-id. Med två prenumerationer på samma kund nedgraderar uppsägning av den ena kontot fast den andra är aktiv.
- **Förslag:** I `create-checkout`: avvisa (409) om `effective_plan = 'pro'` via Stripe eller om `stripe_subscription_id` finns. Skapa Stripe-kunden server-side första gången och spara `stripe_customer_id` *innan* sessionen skapas, så att alla sessioner får samma `customer`. I webhooken: nedgradera bara om `sub.id = profiles.stripe_subscription_id`. Gå igenom Stripe en gång efter kunder med fler än en aktiv prenumeration.

### H4. ✅ Klienten styr indatastorleken – verklig kostnad kan bli flera gånger estimatet *(kontrollerat)*
> **Åtgärdat 2026-10-12** (**deployad 2026-10-12**: migration `20261012140000` körd och verifierad, `generate-site` v44, `edit-element` v11; klientdelen väntar på Vercel-deploy): (1) Estimatet för ny sajt räknar med historikens storlek (1 200 + tecken/3 tokens); för element-ändring med elementets storlek (300 + tecken/2,5) och hela output-budgeten (4 096), så den inte kan överdras. (2) Historikmeddelanden begränsas till 4 000 tecken (samma som en prompt; live max idag 165). (3) Ett negativt saldo följer nu med vid månadsreset och förnyelse (`saldo := tilldelning + min(saldo, 0)`), så överdrag betalas av i stället för att nollas. Klientens estimat (`credits.js`, Chat, Editor) är synkade. Ny sajt utan historik: oförändrat 60 721; element-ändring: 22 859–44 858 (tidigare fast 17 050).
- **Område:** Pengar (gratis credits)
- **Fil:** `supabase/functions/_shared/validation.ts:12-22` (`history` upp till 40 × 20 000 tecken, body upp till 640 kB), `supabase/functions/generate-site/index.ts:545-548`, `:598-605`; `supabase/functions/edit-element/index.ts:16`, `:117`; `settle_credits` i `20261011220000_reserve_settle_credits.sql`
- **Problem:** Reservationen bygger på ett fast estimat: 3 000 input-tokens med historik, och 500 för element-ändring. `settle_credits` drar sedan den verkliga kostnaden **utan golv**. En klient som skickar 600 kB `history` ger ~150 000 input-tokens (~165 000 credits för ett enda anrop) men reserverar bara ~63 000. Saldot blir kraftigt negativt. `reset_monthly_counters` sätter saldot till tilldelningen (`saldo := 68 000`), så **skulden försvinner den 1:a**. Samma sak gäller `edit-element`: element på upp till 50 000 tecken, estimat 17 050. Detta är fynd 22 i `ARKITEKTUR.md` 8.4, men större än beskrivet där.
- **Förslag:** Beräkna estimatet på faktisk indata: tecken i `history` + `prompt` + `elementHtml` delat med ~2,5, plus `max_tokens` × output-sats som övre gräns. Reservera alltså värsta fallet och justera ned vid settle. Begränsa `history` hårdare; servern bör läsa historiken från `chat_messages` i stället för att lita på klienten. Överväg att låta månadsreseten dra av negativt saldo (`saldo := tilldelning + min(saldo, 0)`).

### H5. ✅ Lösenordsåterställning saknar steget "välj nytt lösenord" *(kontrollerat)*
> **Åtgärdat 2026-10-12** (frontend, **väntar på Vercel-deploy** (push blockerad av behörighetsregeln); **kräver** att `<origin>/reset-password` läggs till under Auth → URL configuration → Redirect URLs i Supabase): ny sida `/reset-password` (`src/pages/ResetPassword.jsx`) som tar emot återställningssessionen och sparar nytt lösenord med `updateUser`; visar "länken är ogiltig" utan session. "Forgot password?" på Login skickar mejlet (kräver ifylld e-post). Settings pekar om länken dit. `supabase/README.md` uppdaterad. Testat i webbläsaren: sidan utan session och knappen utan e-post. Hela flödet med riktigt mejl är inte testat.
- **Område:** Bugg (trasigt flöde)
- **Fil:** `src/pages/Settings.jsx:112-123` (`resetPasswordForEmail` med `redirectTo: /login`), `src/pages/Login.jsx` (ingen hantering). `updateUser` och `PASSWORD_RECOVERY` förekommer ingenstans i `src/`.
- **Problem:** Länken i e-postmeddelandet loggar in användaren med en återställningssession och skickar hen till `/login`. Där visas bara inloggningsformuläret, och nytt lösenord kan aldrig sättas. Login-sidan saknar dessutom "Glömt lösenord?", så den som glömt sitt lösenord kan inte ta sig in alls utom via Google.
- **Förslag:** Lägg till en sida `/reset-password` som lyssnar på `onAuthStateChange` med `PASSWORD_RECOVERY` och anropar `supabase.auth.updateUser({ password })`. Peka `redirectTo` dit, lägg till "Forgot password?" på Login, och lägg till URL:en bland tillåtna redirects i Supabase (se `supabase/README.md`).

### H6. ✅ Det går inte att radera sitt konto *(kontrollerat)*
> **Åtgärdat 2026-10-12** (`delete-account` **deployad 2026-10-12** (v1, 401 utan token verifierat); knappen i Settings **väntar på Vercel-deploy**; inte testat end-to-end): ny Edge Function `delete-account` (`verify_jwt = true`, rate limit 5/min, kräver `{ confirm: 'DELETE' }`) som (1) säger upp eventuell Stripe-prenumeration direkt och avbryter om det misslyckas, (2) nollar `referred_by` hos användare som kontot värvat (den FK:n saknar ON DELETE), (3) raderar auth-användaren; allt annat raderas i kaskad (verifierat mot live-FK:er). Settings har "Delete account…" med inskrivet DELETE som bekräftelse. Policytexten stämmer nu. Ej gjort här: radera enskilda leads i UI:t.
- **Område:** Dataskydd (GDPR art. 17)
- **Fil:** `src/pages/Privacy.jsx:51-53` lovar att "deleting your account removes associated data". Det finns ingen sådan funktion i `src/` eller `supabase/functions/`.
- **Problem:** Användaren kan radera chattar och ändra lead-status, men inte kontot, `profiles`, `generated_sites`, `credit_ledger` eller `referral_activations`. Policyn beskriver en funktion som inte finns. Leads kan inte raderas i UI:t alls.
- **Förslag:** Bygg en Edge Function `delete-account` som (1) säger upp eventuell Stripe-prenumeration, (2) raderar användarens rader (cascade från `profiles` där det finns, annars explicit) och (3) kör `auth.admin.deleteUser`. Lägg en knapp med bekräftelse i Settings. Fram till dess: ändra policytexten till att radering sker på begäran via e-post. Lägg också till radering av leads i UI:t.

---

## Medel

### M1. "Fullscreen" kör genererad HTML i appens origin *(kontrollerat)*
- **Område:** Säkerhet (XSS / stöld av token)
- **Fil:** `src/pages/Chat.jsx:272-280` (`window.open(blobUrl)`), `vercel.json:14` (`script-src 'self' 'unsafe-inline'`)
- **Problem:** I förhandsvisningen körs sajten säkert (sandlåda utan `allow-same-origin`). "Fullscreen" öppnar däremot samma HTML som en `blob:`-URL i en ny flik **utan sandlåda**. En blob-URL ärver skaparens origin, alltså appens, och skript i den kan läsa `localStorage` med Supabase-sessionen. `noopener` skyddar inte mot det. `'unsafe-inline'` i CSP:n tillåter inline-skript, och `img-src https:` gör det lätt att skicka ut token. Den genererade HTML:en påverkas av prompten, som i sin tur innehåller Google Places-data (företagsnamn, adress) som tredje part styr. En prompt injection via ett företagsnamn kan alltså i värsta fall ge kontoövertagande. Kommentaren på `Chat.jsx:81-87` antar att blob-dokument är isolerade, men det gäller bara inuti iframen.
- **Förslag:** Öppna helskärm som en egen route i appen (t.ex. `/app/preview/:siteId`) som visar sajten i en helskärms-iframe med samma `sandbox` som förhandsvisningen. Ta bort `'unsafe-inline'` från `script-src`; appen har inga inline-skript, och `analytics.js` laddar gtag externt.

> **Åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; inte testat i webbläsare med inloggat konto): "Fullscreen" öppnar inte längre en ny flik. Samma sandlådade iframe visas i ett helskärmsöverlägg (webbläsarens helskärm när det går), stängs med Esc eller knappen. **Inte gjort:** att ta bort `'unsafe-inline'` ur CSP:n. Moderna webbläsare låter `blob:`-dokument ärva skaparens CSP, så förhandsvisningens inline-skript och Editorns injicerade markeringsskript kan sluta fungera. Det måste testas mot en Vercel-preview innan det ändras.

### M2. Webhooken ger Pro utan att kontrollera betalstatus *(trolig)*
- **Område:** Pengar
- **Fil:** `supabase/functions/stripe-webhook/index.ts:97-109`
- **Problem:** `checkout.session.completed` behandlas som betald. Med asynkrona betalmetoder (SEPA, Klarna, Bancontact m.fl.) kan `payment_status` vara `unpaid` när händelsen kommer. Användaren får då Pro och 680 000 credits innan pengarna kommit in, och behåller saldot även om betalningen misslyckas. Hur stor risken är beror på vilka betalmetoder som är påslagna i Stripe; bara kort ger `paid` direkt. Återbetalningar och tvister (`charge.refunded`, `charge.dispute.created`) hanteras inte heller.
- **Förslag:** Tillämpa bara om `session.payment_status` är `paid` eller `no_payment_required`. Hantera `checkout.session.async_payment_succeeded`. Alternativt: begränsa Checkout till kort (`payment_method_types[]=card`).

> **Åtgärdat 2026-10-12** (`stripe-webhook` **deployad 2026-10-12** (v26); inte testat mot Stripe): `checkout.session.completed` uppgraderar bara när `payment_status` är `paid` eller `no_payment_required`. Annars väntar uppgraderingen på `checkout.session.async_payment_succeeded`, som hanteras på samma sätt. En misslyckad fördröjd betalning uppgraderar aldrig. **Kräver** att webhook-endpointen i Stripe också prenumererar på `checkout.session.async_payment_succeeded` (test och live). **Inte gjort:** återbetalningar och tvister (`charge.refunded`, `charge.dispute.created`) hanteras fortfarande manuellt.

### M3. Obegränsat antal gratiskonton *(kontrollerat i kod)*
- **Område:** Pengar
- **Fil:** `supabase/schema.sql` / `handle_new_user()` (68 000 credits vid signup), `src/pages/Signup.jsx`
- **Problem:** Varje nytt konto får 68 000 credits (ungefär en sajt), och det finns ingen captcha eller enhets- eller IP-spärr. Med Google OAuth eller engångsadresser kan man skapa många konton. Värvningsbonusen (5 konton som var och en genererar en sajt ger en månad Pro = 680 000 credits) kan farmas på samma sätt, eftersom IP-skyddet är svagt (M4).
- **Förslag:** Slå på Supabase Auth captcha (hCaptcha/Turnstile) och e-postbekräftelse. Överväg att ge gratiskrediterna först efter bekräftad e-post, eller en lägre startsumma. Kräv för värvningsbonus att det värvade kontot är verifierat och har fler än en åtgärd.

> **Åtgärdat i kod 2026-10-12** (frontend, väntar på Vercel-deploy; widgeten testad lokalt med Cloudflares testnyckel): ny `Captcha.jsx` (Cloudflare Turnstile) på Signup och Login; token skickas vid registrering, inloggning med lösenord och "Forgot password?". Knapparna är låsta tills captcha är klar. Utan `VITE_TURNSTILE_SITE_KEY` visas ingen widget och allt fungerar som förut. "Change Password" i Settings går nu direkt till `/reset-password` (inloggad användare, `updateUser`, ingen captcha behövs). CSP tillåter `challenges.cloudflare.com`. **Kräver** (i den här ordningen, se `supabase/README.md` 3b): Turnstile-widget i Cloudflare → site key i Vercel → deploy → captcha + "Confirm email" på i Supabase. **Inte gjort:** Google OAuth täcks inte av captcha; credits ges fortfarande vid signup (inte först efter bekräftad e-post); värvningskrav oförändrade.

### M4. IP läses från `X-Forwarded-For` *(kontrollerat)*
- **Område:** Säkerhet (rate limiting, missbruk)
- **Fil:** `supabase/functions/_shared/guards.ts:49-53`
- **Problem:** `clientIp()` tar första värdet i `X-Forwarded-For`, och det värdet sätter klienten själv. IP-baserad rate limiting (`enforce(..., clientIp(req))`) kringgås genom att skicka ett nytt värde varje gång. Gränsen per användare finns kvar för inloggade funktioner, men `stripe-webhook` har bara IP-gräns. Värvningsskyddet mot samma IP (`claim-referral`) påverkas också. Se `ARKITEKTUR.md` 8.3 punkt 13.
- **Förslag:** Använd det värde Supabase edge-plattformen själv sätter (`cf-connecting-ip` först, eller sista värdet i `X-Forwarded-For` som lagts till av betrodd proxy). Verifiera med en loggad testrequest vilket header-värde som är pålitligt.

> **Kontrollerat 2026-10-12, ingen kodändring behövs:** testanrop mot `stripe-webhook` med förfalskad `X-Forwarded-For` (`203.0.113.77`, och `198.51.100.9, 203.0.113.5` plus `X-Real-IP`) räknades i `rate_limits` under anroparens riktiga IP (`webhook:<riktig IP>`, count 1 → 2). Supabase-gatewayn skriver alltså över headern, och första värdet går att lita på. En förfalskad `CF-Connecting-IP` stoppas med 403 innan funktionen. Kommentar om detta tillagd i `guards.ts` (ingen deploy behövs). Fyndet gäller bara om funktionerna flyttas bakom en annan proxy.

### M5. Editor visar "Saved" även när sparningen misslyckas *(kontrollerat)*
- **Område:** Bugg (dataförlust)
- **Fil:** `src/pages/Editor.jsx:233-240`
- **Problem:** `saveToDb` ignorerar `error` från `update` och visar alltid "Saved". Vid nätverksfel eller utgången session har användaren betalat för element-ändringen men förlorar den när sidan stängs.
- **Förslag:** Kontrollera `error`, visa fel och en "Försök igen"-knapp, och varna vid `beforeunload` om osparade ändringar finns.

> **Åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; inte testat i webbläsare): `saveToDb` kontrollerar fel och att en rad faktiskt uppdaterades (RLS ger 0 rader i stället för fel). Vid fel visas "Not saved" med en "Retry"-knapp (felmeddelandet som tooltip), och sidan varnar vid stängning så länge ändringen inte är sparad. Kontrollerat i DB: `authenticated` har UPDATE på `generated_sites.html_output` och RLS-policyn `auth.uid() = user_id` gäller.

### M6. Ångra/gör om/återställ version i Editor sparas aldrig *(kontrollerat)*
- **Område:** Bugg
- **Fil:** `src/pages/Editor.jsx:213-231`
- **Problem:** `undo`, `redo` och `restoreVersion` ändrar bara det lokala tillståndet. Databasen har kvar den senaste AI-ändringen. Den som ångrar, lämnar Editor och öppnar Chat eller Editor igen ser den ångrade versionen. Historiken försvinner vid omladdning.
- **Förslag:** Spara efter undo/redo/restore (eventuellt med debounce), eller visa en tydlig "Spara"-knapp med osparad-markering.

> **Åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; inte testat i webbläsare): ångra, gör om och återställ version sparar nu den version som visas, med 600 ms fördröjning så att flera klick i rad blir en skrivning. En väntande sparning skickas direkt när man lämnar Editor inom appen, webbläsaren varnar vid stängning medan den väntar, och en ny AI-ändring avbryter den så att den inte skrivs över. Fel visas med "Not saved"/"Retry" (M5). ~~Historiken sparas inte mellan omladdningar.~~ **Uppföljning 2026-10-12:** migration `20261012160000_site_versions.sql` (ny tabell `site_versions`, RLS per användare, ingen UPDATE) + Editor sparar en version per AI-ändring (med "Original" vid första ändringen) och läser listan när den öppnas. Utan tabellen fungerar Editor som förut. Samtidigt fixat: History-menyn klipptes av navbaren (nu `fixed`), och Back landade på en återkallad `blob:`-URL eftersom iframens `src`-byten lade till webbläsarhistorik (iframen skapas nu om per version, även i Chat).

### M7. Pro via värvning visar "Manage Billing", som alltid ger fel *(kontrollerat)*
- **Område:** Bugg / Pengar (förlorad försäljning)
- **Fil:** `src/pages/Settings.jsx:141-146`, `supabase/functions/create-portal/index.ts:33`
- **Problem:** `isProUser()` räknar `pro_until` som Pro. En användare som fått Pro via värvning ser därför "Manage Billing", som svarar 400 "No Stripe customer on file", och har ingen väg att köpa Pro under eller efter perioden förrän den gått ut.
- **Förslag:** Visa "Manage Billing" bara om `stripe_customer_id` finns. Visa annars "Pro till <datum>" och en "Upgrade"-knapp.

> **Åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; inte testat i webbläsare): "Manage Billing" visas bara när kontot har en Stripe-prenumeration (`stripe_subscription_id`). Pro via värvning visar "until <datum>" under planen och "Upgrade to Pro" (`create-checkout` blockerar bara konton med prenumeration). Manuellt satt Pro utan prenumeration och utan `pro_until` (2 konton i live) visar ingen knapp.

### M8. Stats räknar varje sajtversion som en egen sajt *(kontrollerat)*
- **Område:** Bugg (fel statistik)
- **Fil:** `src/pages/Stats.jsx:19-35`; `generate-site/index.ts:641-645` skapar en ny rad per chatt-ändring
- **Problem:** "Total sites generated" och konverteringsgraden räknar varje chatt-ändring som en ny sajt. Fem ändringar av en sajt ger 6 sajter och en sjättedel så hög konvertering. Sålda sajter markeras dessutom på en enskild version.
- **Förslag:** Räkna per `session_id` (senaste versionen per session), eller lägg status och pris på `chat_sessions` i stället.

> **Åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; inte testat i webbläsare): Stats slår ihop versioner per `session_id` i klienten. En sajt visas med senaste versionens uppgifter, räknas från första versionens datum och räknas som såld om någon version är markerad såld (det är den versionen "Mark Sold"/"Edit" ändrar). Rader utan session räknas var för sig. Ingen DB-ändring. Live idag: 12 rader, 8 utan session och 4 sessioner med en version var, så siffrorna ändras inte förrän någon gör chatt-ändringar.

### M9. Samma företag kan sparas som lead flera gånger *(kontrollerat)*
- **Område:** Bugg / Pengar (användarens kvot)
- **Fil:** `supabase/functions/scrape-leads/index.ts:168-171`; ingen unik nyckel på `leads` (`supabase/schema.sql`)
- **Problem:** `place_id` sparas inte, och dubbletter filtreras inte bort. Två liknande sökningar ("frisör Karlstad" och "frisörer Karlstad") sparar samma företag igen och drar av kvoten två gånger.
- **Förslag:** Spara `place_id` (det är också den enda Places-data Google tillåter att lagras utan tidsgräns, se M11), lägg till ett unikt index `(user_id, place_id)`, hoppa över kända place_id innan Details-anropet och räkna bara nya.

> **Åtgärdat 2026-10-12** (**deployad 2026-10-12**: migration körd och verifierad, `scrape-leads` v30; inte testat med en riktig sökning): migration `20261012150000_leads_place_id.sql` lägger till `leads.place_id` och ett unikt index `(user_id, place_id)`. `scrape-leads` hämtar användarens redan sparade place_id innan Details-anropen, hoppar över dem (ingen kvot, inget Details-anrop), sparar `place_id` och skriver med `ON CONFLICT DO NOTHING` för samtidiga sökningar. Leads-sidan visar hur många som redan fanns. **Ordning:** migrationen före funktionen, annars svarar `scrape-leads` med fel. Befintliga leads saknar `place_id` och kan därför inte dubblettkontrolleras.

### M10. På mobil går det inte att byta chatt eller starta en ny *(kontrollerat)*
- **Område:** UX / Mobil
- **Fil:** `src/pages/Chat.jsx:285-298` (SessionsPanel bara när `!isMobile`)
- **Problem:** På mobil öppnas alltid senaste chatten. Det finns ingen knapp för ny chatt och ingen lista över tidigare chattar. Att generera en sajt för en ny kund kräver att man går via Leads.
- **Förslag:** Lägg till en "Chattar"-flik eller en bottensheet med SessionsPanel och en "Ny chatt"-knapp i mobilhuvudet.

> **Åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; inte testat i webbläsare): mobilhuvudet har en tredje flik "Chats" som visar SessionsPanel i full bredd, med "+ New chat", byte av chatt och radering. Val av chatt eller ny chatt växlar till fliken Chat. Plan-märket döljs på mobil så att flikarna får plats.

### M11. Lagring av Google Places-data och tredje persons uppgifter *(kontrollerat i kod; juridisk bedömning behövs)*
- **Område:** Dataskydd / Avtal
- **Fil:** `supabase/functions/scrape-leads/index.ts:156-171`, `src/pages/Privacy.jsx:19`
- **Problem:** Namn, adress, telefon och betyg från Google Places sparas permanent och kan exporteras som CSV. Google Maps Platforms villkor tillåter i regel bara att `place_id` lagras permanent; övrig data får bara cachas tillfälligt. Leads är dessutom ofta personuppgifter om tredje person (enskilda firmor: namn och telefon). Integritetspolicyn beskriver inte rättslig grund, lagringstid eller hur de berörda informeras.
- **Förslag:** Läs igenom Googles villkor ("Caching" i Places API Policies). Spara `place_id` och hämta detaljer på nytt vid behov, eller rensa detaljer efter 30 dagar. Dokumentera rättslig grund (berättigat intresse) och lagringstid i policyn, och lägg till radering av leads.

> **Delvis åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; inte testat i webbläsare): Leads-sidan har kryssrutor, "Delete N" för markerade och "Delete" i detaljraden (med bekräftelse). RLS tillåter redan radering (`leads self all`), och `chat_sessions.lead_id` sätts till null, så chattar finns kvar. Integritetspolicyn har ett nytt avsnitt om lead-data: källa, rättslig grund (berättigat intresse), lagring tills användaren raderar, och att företag kan begära borttagning. **Kvar (juridisk bedömning):** Googles villkor för cachning; Places-detaljerna lagras fortfarande permanent. Ett alternativ är att rensa detaljer efter 30 dagar och behålla `place_id` (nu sparat, M9). Policytexten är en mall, inte juridisk rådgivning.

### M12. Google Analytics laddas före samtycke och "Accept" ger annonssamtycke *(kontrollerat)*
- **Område:** Dataskydd (ePrivacy/GDPR)
- **Fil:** `src/lib/analytics.js:31-56`, `:63-68`, `:85-88`
- **Problem:**
  - `gtag.js` laddas och `page_view` skickas redan innan användaren svarat. Consent Mode skickar då cookielösa pingar till Google, vilket flera EU-tillsynsmyndigheter anser kräver samtycke.
  - "Accept" (analys) sätter även `ad_storage`, `ad_user_data` och `ad_personalization` till `granted`, alltså mer än användaren godkänt.
  - `page_location` skickar hela URL:en, inklusive `?ref=SF-XXXXXX`.
- **Förslag:** Ladda gtag först efter "Accept". Ge bara `analytics_storage: 'granted'` och låt ad-signalerna vara nekade. Ta bort query-strängen från `page_location`.

> **Åtgärdat 2026-10-12** (frontend, väntar på Vercel-deploy; **testat** mot lokal produktionsbuild med headless Chromium): `gtag.js` hämtas först efter "Accept" (eller vid tidigare sparat "granted"); före svar och efter "Decline" går inga anrop till Google. Consent-läget är `analytics_storage: granted` och alla ad-signaler `denied`. `page_view` skickas utan query-sträng (`?ref=SF-TEST01` syntes inte i `page_location`), och sidan man accepterar på får en page view direkt.

---

## Låg

| # | Område | Fil:rad | Problem | Förslag |
|---|---|---|---|---|
| L1 | Pengar | `generate-site/index.ts:678-682` | En misslyckad chatt-ändring återbetalar hela estimatet fast tokens förbrukats (ARKITEKTUR 21). | Ta betalt för förbrukade tokens, eller en fast avgift vid `edit_failed`. |
| L2 | Pengar | `generate-site/index.ts:535-541` | Klassificeringen (Haiku) körs före reservationen, alltså gratis även med 0 saldo (ARKITEKTUR 23). | Kontrollera `credit_balance > 0` före klassificeringen. |
| L3 | Pengar | migration `20261011210000`, `settle_credits` | En månadsreset under en pågående reservation ger fel saldo (ARKITEKTUR 25). | Låt reseten räkna med öppna reservationer, eller låt `settle` justera mot reservationens tidpunkt. |
| L4 | Bugg | `credit_ledger` | Ingen städning av `reserved`-rader som blir hängande (ARKITEKTUR 27). 0 rader live idag. | Cron som återbetalar `reserved` äldre än 15 min. |
| L5 | Pengar | `stripe-webhook/index.ts:75-83` | Webhook-hemligheten väljs efter aktuellt `stripe_mode`. Händelser från det andra läget avvisas, och Stripe försöker igen i dagar. | Prova båda hemligheterna, eller ha separata endpoints för test och live. |
| L6 | Säkerhet | `stripe-webhook/index.ts:39-51` | Bara sista `v1=` i signaturen kontrolleras; vid rotation av hemlighet kan giltiga händelser avvisas. | Jämför mot alla `v1`-värden. |
| L7 | Säkerhet | `stripe-webhook/index.ts:61` | Webhooken har IP-rate-limit 120/min. Stripe skickar från delade IP:n, så en topp kan ge 429 och försenad uppgradering. | Ta bort IP-gränsen; signaturen räcker som skydd. |
| L8 | Säkerhet | `create-checkout/index.ts:24`, `create-portal/index.ts:24` | `origin` från klienten används som `success_url`/`return_url` (öppen redirect via Stripe). | Använd en fast `APP_URL` från secrets. |
| L9 | Säkerhet | `_shared/guards.ts:18-22`, `scrape-leads/index.ts:173`, `generate-site/index.ts:440`, `:685` | Interna felmeddelanden (DB-fel, Anthropics svarstext) skickas till klienten. | Logga detaljer server-side och skicka en felkod till klienten. |
| L10 | Säkerhet | `claim-referral`, `generate-referral-code`, `referral-stats` | Ingen rate limit. `claim-referral:37` fångar inte `HttpError` från `readBoundedJson` (ger 500). | Lägg till `enforce()` och try/catch med `fromHttpError`. |
| L11 | Säkerhet | `src/pages/Editor.jsx:181-191` | `message`-lyssnaren kontrollerar inte `e.source === iframe.contentWindow`. | Lägg till kontrollen. **Åtgärdat 2026-10-12** (även typkontroll av `outerHtml`). |
| L12 | Bugg | `src/pages/Editor.jsx:259` | `html.replace(str, updatedHtml)` tolkar `$&`, `` $` ``, `$'` i AI-svaret som specialmönster. | Använd `html.replace(str, () => updatedHtml)`. **Åtgärdat 2026-10-12.** |
| L13 | Säkerhet | `src/pages/Leads.jsx:128-139` | CSV-export utan skydd mot formel-injektion (företagsnamn som börjar med `=`, `+`, `-`, `@`). | `Papa.unparse(rows, { escapeFormulae: true })`. **Åtgärdat 2026-10-12** med egen `csvSafe()` som lämnar rena telefonnummer (`+46 …`) orörda. |
| L14 | Säkerhet | Supabase Auth (rådgivare) | Skydd mot läckta lösenord (HaveIBeenPwned) är avstängt; minsta lösenordslängd är 6 (`Signup.jsx:70`). | Slå på i dashboarden och höj till minst 8. |
| L15 | Säkerhet | DB (rådgivare) | `purge_rate_limits` saknar `search_path`. `handle_new_user` har EXECUTE för `anon`/`authenticated` (ofarligt eftersom det är en triggerfunktion, men varnas). | Migration: `set search_path = public` och `revoke execute ... from anon, authenticated`. |
| L16 | Bugg | `src/lib/auth.jsx:39-45`, `:48-56` | Gammal profil kan visas efter byte av användare vid fel; `loading = false` med `profile = null` (ARKITEKTUR 24, 28). | Nollställ profilen när `uid` ändras; sätt `loading` i `loadProfile`. |
| L17 | Bugg | `src/lib/api.js:43-87` | Ingen timeout eller avbrott för SSE. Vid tappad uppkoppling kan "generating…" snurra länge. | `AbortController` med timeout och omförsök/felmeddelande. |
| L18 | Bugg | `src/pages/Chat.jsx:157-166`, `:186-240`; `Leads.jsx:102-105` | Fel från `chat_messages`-insert, `deleteSession` och `updateStatus` ignoreras; ingen återställning av optimistisk ändring. | Kontrollera `error` och visa det. |
| L19 | UX | `src/components/SessionsPanel.jsx:43-52` | Radera chatt utan bekräftelse; knappen syns bara vid hover och saknar `aria-label`. | Bekräftelsedialog, synlig knapp, `aria-label="Delete chat"`. |
| L20 | Prestanda | `Leads.jsx:47-50`, `Stats.jsx:19-22`, `Chat.jsx:67-70` | Alla leads, sajter och chattar hämtas utan paginering. | `range()` med "Ladda fler" / virtuell lista, och aggregering i SQL för Stats. |
| L21 | Prestanda | `src/lib/api.js:52`, `:57` | `console.log` för varje SSE-chunk i produktion (inklusive HTML-utdrag). | Ta bort eller lägg bakom `import.meta.env.DEV`. |
| L23 | Bugg | `src/pages/Chat.jsx:179`, `_shared/validation.ts` (`history` max 40) | *Ny 2026-10-12.* Klienten skickar hela chatthistoriken; efter 40 meddelanden (20 utbyten) svarar servern 400 `invalid_input` och chatten går inte att använda. | Skicka bara de senaste 40 (`messages.slice(-40)`), och räkna estimatet på samma urval. |
| L22 | Prestanda | `dist/assets/index-*.js` (424 kB okomprimerat) | `Chat` och `Landing` laddas direkt (inte lazy); Stats/recharts 389 kB är lazy (bra). | Lazy-ladda `Chat`, och `Landing` för inloggade. |

### Kodkvalitet och tillgänglighet (Låg, samlat)
- **Död kod / kvarlevor:** `PLAN_LIMITS.generations` (`_shared/auth.ts:21-24`, `src/lib/api.js:89-92`) används inte. `data.reviewed` (`Chat.jsx:209`) skickas aldrig av servern. `LEDGER_LABELS.classify` (`credits.js:72`) har ingen motsvarande `action_type`. `VITE_STRIPE_PUBLISHABLE_KEY` och `config.stripe_webhook_secret` läses inte av någon kod (ARKITEKTUR 14).
- **Duplicering:** `getCreditRates`, `computeCredits` och `callClaude` finns i både `generate-site` och `edit-element`. Kreditsatser och tilldelning finns hårdkodade i `src/lib/credits.js` och i DB-tabellen `config`. Leadsgränsen är hårdkodad i `Settings.jsx:31` (ARKITEKTUR 10). Flytta delad logik till `_shared/credits.ts`.
- **Inaktuellt:** Sidebar visar `v1.0.1`, `package.json` säger `1.1.0`. `.env.example` har en annan modell än kodens standard (ARKITEKTUR 16). `README.md`/`TODO.md` beskriver OpenAI.
- **Tillgänglighet:** Klickbara `div`/`tr` (SessionsPanel, lead-rader) går inte att nå med tangentbord. Ikonknappar (`×`, `✕`) saknar `aria-label`. `SaleModal` saknar `role="dialog"`, fokusfälla och Escape-stängning. Mycket liten text (9–11 px) på flera ställen. Fältetiketter är `div` i stället för `<label for>`.

---

## Vad som kontrollerades och såg bra ut
- **Hemligheter:** Endast `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GA_MEASUREMENT_ID` (och en oanvänd `VITE_STRIPE_PUBLISHABLE_KEY`) bundlas. Ingen `service_role` eller Stripe-hemlighet finns i `dist/` eller i git-historiken, och `.env*` är gitignorerade.
- **Behörighet:** RLS är på för alla 10 tabeller. Klienter kan bara läsa `profiles`, `credit_ledger` och `referral_activations`. Alla kredit- och Stripe-funktioner kan bara köras av `service_role`. Alla Edge Functions utom webhooken kräver giltig token (`verify_jwt = true` + `getUser`), och `edit-element` kontrollerar ägarskap av sajten.
- **Webhook:** HMAC-SHA256 med tidsjämförelse i konstant tid, 300 s tolerans, idempotens via `stripe_events`, och DB-fel ger 500 så att Stripe försöker igen.
- **Credits:** Reservationen är atomisk (`... where credit_balance >= p_amount`), så parallella anrop kan inte dra under noll *före* AI-anropet. Saldo och ledger skrivs i samma transaktion.
- **Injection:** Ingen rå SQL från klienten; all indata går via supabase-js eller zod-validerade fält. Google Places-parametrar URL-kodas.
- **Förhandsvisning:** iframe med `sandbox` utan `allow-same-origin` i både Chat och Editor.
- **Filuppladdning:** Finns inte i appen. Ingen uppladdningsyta att granska.

## Föreslagen ordning
1. **H1 + H2** (Google-kostnad): sätt först budget- och kvotgräns i Google Cloud (ingen kod), sedan atomisk kvot och räkning av undersökta företag.
2. **H3** (dubbla prenumerationer) och **M2** (betalstatus).
3. **H4** (estimat efter faktisk indatastorlek).
4. **H5** (lösenordsåterställning) och **H6** (kontoradering).
5. **M1** (helskärm i sandlåda + ta bort `'unsafe-inline'`).
6. Övriga Medel, sedan Låg.
