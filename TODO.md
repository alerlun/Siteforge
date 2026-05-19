# SiteForge — open issues

## ✅ DONE

- AI output style — system prompt now locks Editorial Boutique / Brutalist Editorial / Gradient Mesh families with reference examples + creative seed for diversity. See `supabase/functions/generate-site/index.ts`.
- Google OAuth `redirect_uri_mismatch` — fix documented in README → "Google OAuth setup". (User still hitting it; see /login walkthrough.)
- Sale tracking UX — `SaleModal` component reusable from Chat (under preview) and Stats (per-row "Mark Sold / Edit"). Captures price + type + name + status.
- Output diversity — request now includes `style` (Auto/Editorial/Brutalist/Gradient Mesh) + creative seed + font hint. Temperature bumped to 0.9. Auto picks family by business type.
- 20+ Brutalist + Gradient Mesh examples baked into SYSTEM_PROMPT.
- Bug-review pass — second OpenAI call with strict review prompt scrubs HTML before persisting. Returned `reviewed: true|false` flag in response.
- Side nav of chats — `chat_sessions` + `chat_messages` tables, `SessionsPanel` component on `/app/chat`. New chat button, click to switch, × to delete.

## ⏳ STILL OPEN

- Google OAuth — user still seeing `redirect_uri_mismatch`. Suspect they're editing wrong OAuth client. Diagnosis steps in last chat round.

---

## Migration required

After pulling these changes the database needs the new tables. Re-run `supabase/schema.sql` in Supabase SQL editor (idempotent — safe to re-run).
