# SiteForge — Mobile Reliability, Speed & Cost Design

**Date:** 2026-06-20  
**Status:** Approved

## Context

Three problems reported:

1. iPhone users always get "Stream ended without result" during site generation.
2. Generated websites render as desktop layout on mobile (no visible mobile responsiveness).
3. SiteForge app performance: generation too slow, API cost higher than necessary.

Root causes identified via code inspection before designing fixes.

---

## Section 1: Fix — Stream ended without result (iPhone)

### Root cause

`generate-site/index.ts` line 588 sends the result SSE event as:

```ts
await sse({ type: 'result', site, html, sessionId, retried, edited, detectedLanguage, creditsUsed });
```

`site` is the raw Supabase DB record, which includes `html_output` (the full generated HTML). `html` is also the full HTML. The payload therefore contains the HTML **twice** — for a 60KB site this produces a 120KB+ single SSE message. iOS cellular proxies and Safari truncate or drop large SSE payloads.

### Fix

Strip `html_output` from `site` before sending. Client (Chat.jsx:236) reads `data.html` directly; it only uses `data.site.id`, `data.site.business_name`, `data.site.business_type`, `data.site.client_location` — never `html_output`.

```ts
const { html_output: _dropped, ...siteForClient } = site;
await sse({ type: 'result', site: siteForClient, html, sessionId: resolvedSessionId, retried, edited, detectedLanguage: lang, creditsUsed });
```

Also reduce heartbeat interval from 10s to 5s for more aggressive keep-alive on iOS cellular:

```ts
const hb = setInterval(() => { sse({ type: 'heartbeat' }); }, 5_000);
```

**File:** `supabase/functions/generate-site/index.ts`  
**Lines to change:** 481 (heartbeat interval), 588 (sse result call)

---

## Section 2: Fix — Generated sites not mobile-responsive

### Root cause

System prompt in `buildStaticSystemBlock()` says "Fully responsive (320px–1440px)" but does not explicitly require a viewport meta tag. Claude may omit it inconsistently. Without `<meta name="viewport" content="width=device-width, initial-scale=1">`, mobile browsers use a ~980px virtual layout viewport and scale down — rendering the site as a shrunken desktop version.

### Fix

Add to the TECHNICAL block in `buildStaticSystemBlock()`:

```
- MUST include <meta name="viewport" content="width=device-width, initial-scale=1"> in <head>.
- Mobile-first CSS: all layouts default to single-column, widen at min-width breakpoints (600px, 900px).
```

**File:** `supabase/functions/generate-site/index.ts`  
**Function:** `buildStaticSystemBlock()` (~line 243), TECHNICAL section

---

## Section 3: Speed — Haiku for Classification

### Root cause

`classifyEditRequest()` uses `MODEL` (claude-sonnet-4-6) to classify one user message as "EDIT" or "NEW". This call:
- Takes 2–5s (Sonnet latency for a single-word response)
- Costs ~20× more per token than Haiku
- Is on the critical path — it blocks the build call

### Fix

Introduce a `CLASSIFY_MODEL` constant defaulting to `claude-haiku-4-5-20251001`. Pass it to `callClaude` in `classifyEditRequest`. The task is trivially simple (one word output, 8 max_tokens already set) — Haiku handles it with higher accuracy than needed at 3–5× lower latency.

```ts
const CLASSIFY_MODEL = Deno.env.get('ANTHROPIC_CLASSIFY_MODEL') ?? 'claude-haiku-4-5-20251001';
```

Modify `callClaude` to accept an optional `model` parameter (defaults to `MODEL`), or create a thin `callClaudeModel(model, ...)` variant. Pass `CLASSIFY_MODEL` from `classifyEditRequest`.

Expected impact: saves 2–4s per generation with an existing site. Reduces classify cost ~20×. Most generations drop under 30s total.

**File:** `supabase/functions/generate-site/index.ts`  
**Functions:** `callClaude()` (add optional model param), `classifyEditRequest()` (pass CLASSIFY_MODEL)

---

## Section 4: SiteForge App — Lazy-load Routes

### Root cause

All pages (Chat, Editor, Stats, Settings, Leads, Landing, Login, Signup, Privacy, Terms) load in a single bundle. Editor alone includes the SELECTION_SCRIPT injection logic, device toggle state, version history, and element edit panel. Users who only use Chat pay the full bundle cost on initial load.

### Fix

Use React `lazy()` + `Suspense` in `src/App.jsx` for non-critical routes. Critical path (Login, Signup, Landing, Chat) stays eager. All others lazy:

```jsx
const Editor   = lazy(() => import('./pages/Editor.jsx'));
const Stats    = lazy(() => import('./pages/Stats.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Leads    = lazy(() => import('./pages/Leads.jsx'));
```

Wrap router outlet in `<Suspense fallback={null}>` (or a minimal spinner). Vite will automatically code-split at these import boundaries.

**File:** `src/App.jsx`

---

## Verification

1. **Stream fix**: Generate a site on iPhone (cellular, not WiFi). Should complete without "Stream ended without result". Check browser console for `[readSSE] chunk` logs — payload of the result event should be ~50–80KB (not 120–160KB).

2. **Mobile responsive output**: Generate a site, open the downloaded HTML on iPhone in Safari. Should render single-column, not scaled-down desktop. Viewport meta tag must be present in the `<head>`.

3. **Haiku classify speed**: Generate a site where an existing site is in context (edit path). Time from submit to result — should be 2–4s faster than before. Check Supabase edge function logs for classify call duration.

4. **Lazy loading**: Run `npm run build`, check Vite output. Should see separate chunks for Editor, Stats, Settings, Leads. Initial bundle size should decrease.
