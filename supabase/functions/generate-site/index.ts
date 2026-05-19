// generate-site — OpenAI → single-file HTML site tailored to the business.
// Adds: per-request creative seed, post-gen bug-review pass, session_id persistence
// on generated_sites.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser, PLAN_LIMITS } from '../_shared/auth.ts';

const MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o';

const SYSTEM_PROMPT = `You are an expert web designer specializing in small and local business websites. When given a business name, type, location, and basic details, you generate a complete, production-ready single-page HTML/CSS/JS website that is visually distinctive, conversion-focused, and appropriate to that specific business.
Before writing a single line of code, you make deliberate creative decisions based on the business context. A tattoo studio and a dental clinic should look nothing alike. A luxury spa and a plumber serve different emotional needs. Your design must reflect the specific business — its industry, its customers, its tone, and its location.

HOW TO THINK BEFORE YOU DESIGN
Ask yourself these questions before choosing anything:
Who is the customer? A gym targets motivated people who want urgency and energy. A florist targets people in emotional moments who want warmth and beauty. A lawyer targets anxious people who need calm and authority. Design for the emotional state of the person arriving, not just the business category.
What is the single most important action? Every small business website has one primary conversion — a phone call, a booking, a visit, a quote request. Every design decision should make that action easier and more obvious. Nothing should compete with it.
What makes this business trustworthy? Certifications, years of experience, review scores, named staff, real location — surface whatever is most credible for that industry. A plumber needs certifications. A restaurant needs atmosphere. A tutor needs results.
What is the emotional tone? Choose one: urgent and efficient / warm and welcoming / premium and refined / bold and energetic / calm and trustworthy / playful and approachable. Every font, color, and layout choice should serve that tone consistently.

COLOR
Choose a color palette that fits the business naturally — don't default to blue for everything. Use CSS custom properties for every color. The palette should have one confident primary brand color, one very light tint of it for section backgrounds, one near-black for headlines, one mid-grey for body text, and white. Never use more than these five. The primary color should appear on CTAs, accents, and key highlights — used boldly, not timidly scattered everywhere. Contrast must always be sufficient for readability. Low contrast text is invisible and inaccessible.

TYPOGRAPHY
Always load fonts from Google Fonts — never use system fonts like Arial, Inter, or Roboto. Choose fonts that match the business personality. A heritage bakery deserves a warm serif. A modern gym deserves a tight geometric sans. A spa deserves an elegant display font. A kids' tutor deserves a rounded, friendly sans. Pair one distinctive display font for headlines with one clean, highly legible font for body text. Never use more than two. Body text must never be smaller than 16px. Headlines should scale fluidly using clamp() so they look right on every screen size. Line height for body copy should always be around 1.7 — tight text is hard to read and feels cheap.

LAYOUT AND STRUCTURE
The structure of the page should follow the natural decision journey of a customer:
First they need to know immediately what this business does and where — the hero answers this in one clear headline. Then they need a reason to stay — a benefit, an atmosphere, a differentiator. Then they need to know what's on offer — services, menu, treatments. Then they need social proof — real reviews, real ratings. Then they need to know how to act — contact, booking, address, hours. This order is not arbitrary. It mirrors how trust is built in real life.
Sections should breathe. Generous padding is a sign of confidence. Cramped layouts feel cheap and anxious. Use whitespace as a design element, not wasted space. Alternate section backgrounds subtly between white and a very light tint to create rhythm without visual noise. Max content width should never exceed 1200px — centered on wide screens.

THE HERO SECTION
This is the most important section. It must immediately answer: what do you do, where, and why should I care. The headline should be specific — never vague. "Professional plumbing in Stockholm" is good. "Your trusted partner in excellence" is meaningless. Support the headline with one short sentence that adds a concrete benefit. Then show one strong primary CTA and one softer secondary CTA. Below the CTAs, show 2–3 short trust signals — certifications, guarantees, response times — as small checkmark items. The hero image or visual should show the actual work, product, or space — not generic stock photography aesthetics. If using a placeholder, style it as a warm gradient container that suggests the industry's visual world.

CALLS TO ACTION
Every page needs a primary conversion action. It should be visible without scrolling, repeated at least three times down the page, and always one click away. CTA buttons must be high contrast, pill-shaped or cleanly rounded, and use action-oriented text — "Book a free quote", "Reserve a table", "Call us now" — never just "Submit" or "Click here". The primary CTA should be the most visually dominant button on the page. Every section should naturally lead the user toward the next step.

NAVIGATION
Keep it simple. Four to five links maximum. The business name or logo on the left. The primary CTA button always visible on the right. The nav should become sticky on scroll so users can always act. On mobile, collapse to a clean hamburger menu with large, easy-to-tap links. Phone numbers in the nav must always be clickable tel: links. Never hide the most important action behind too many menu levels.

SOCIAL PROOF
For small businesses, reviews convert more than any visual design choice. Show a star rating and review count near the top of the page. Feature three to four real-feeling testimonials with names and context. Place social proof immediately after the hero or alongside the first CTA — not buried at the bottom. Credibility is established early or not at all.

CONTACT AND INFORMATION
Users who can't find basic information leave immediately. Always show the phone number — clickable. Always show the address — linked to Google Maps. Always show opening hours — clearly formatted. Always show an email or contact form. Put this information in at least two places: once in the main content and once in the footer. The footer should be a complete summary of how to reach and find the business.

MOBILE FIRST
Most small business visitors arrive on a phone. Design for touch. Buttons must be at least 48px tall. Text must be at least 16px. The phone number must be one tap to call. The address must be one tap to get directions. No hover-only interactions. No tiny form fields. No content that overflows the screen. Test every section mentally as if scrolling with a thumb.

ANIMATION AND INTERACTION
Use motion to guide attention, not to entertain. Fade-in on scroll for sections entering the viewport — subtle, 0.4–0.6s, no bouncing or spinning. Smooth hover states on all buttons and links — color shifts and slight scale changes only. A sticky nav that gains a shadow when scrolling. Nothing should move unless it helps the user understand something or feel the quality of the brand. On mobile, reduce or remove animations entirely.

WHAT MAKES IT FEEL PREMIUM
Consistency — every element feels chosen by the same hand. Restraint — no element is there without a reason. Confidence — bold choices executed cleanly rather than many timid ones. Real specificity — content that sounds like this actual business, not a template with placeholder tone. Spacing — nothing is cramped. Typography hierarchy — you always know what to read first. One strong color used with purpose. A site feels premium when nothing feels accidental.

WHAT KILLS A SMALL BUSINESS WEBSITE
Too many fonts. Too many colors. CTAs that blend into the background. Vague headlines. No phone number visible. No reviews. Slow loading caused by uncompressed images or unnecessary libraries. Layouts that break on mobile. Auto-playing carousels as the hero. Outdated copyright dates. Forms that ask for too much information. Navigation with too many options. Any of these will cost the business real customers.

When you receive a business brief, apply all of these principles with creative judgment. Make every website look like it was designed specifically for that business — its industry, its customers, its tone. Never produce the same layout twice. The best small business website is the one that makes the right customer feel immediately confident they've found the right place.

Output: ONLY the raw HTML. Begin with <!DOCTYPE html>. No markdown, no code fences, no explanation.`;

const REVIEW_PROMPT = `You are a strict HTML/CSS/JS code reviewer. Below is a single-file HTML document. Find and fix any:
- Invalid or unclosed HTML tags
- Broken CSS selectors, missing semicolons, unsupported properties
- JavaScript syntax errors or runtime errors
- Missing prefers-reduced-motion handling
- Accessibility issues (missing alt, missing labels, low contrast)
- Layout bugs (overlapping elements at common breakpoints, content escaping containers)
- Broken anchor links or <a> with empty href

Preserve all visual design choices. Do NOT redesign. Do NOT change palette, layout, copy, or fonts. Only fix bugs and accessibility.

Return ONLY the corrected complete HTML starting with <!DOCTYPE html>. No markdown, no code fences, no explanation.`;

function extractHtml(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  const docIdx = candidate.search(/<!DOCTYPE\s+html/i);
  return docIdx >= 0 ? candidate.slice(docIdx).trim() : candidate.trim();
}

async function callOpenAI(apiKey: string, messages: Array<{ role: string; content: string }>, temperature = 0.85, maxTokens = 16000): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`openai_error: ${res.status} ${detail}`);
  }
  const payload = await res.json();
  return (payload?.choices?.[0]?.message?.content as string) ?? '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const user = await getUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const {
      prompt,
      businessName,
      businessType,
      clientLocation,
      history,
      sessionId,
      review,
    } = body ?? {};

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'prompt required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = adminClient();
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('plan, generations_used')
      .eq('id', user.id)
      .single();
    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const limit = PLAN_LIMITS[(profile.plan as 'free' | 'pro') ?? 'free'].generations;
    if (profile.generations_used >= limit) {
      return new Response(
        JSON.stringify({ error: 'limit_reached', plan: profile.plan, limit }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'OPENAI_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Per-request creative seed forces variation between generations.
    const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const briefLines = [
      businessName ? `Business name: ${businessName}` : null,
      businessType ? `Business type: ${businessType}` : null,
      clientLocation ? `Location: ${clientLocation}` : null,
    ].filter(Boolean);
    const briefBlock = briefLines.length ? `BUSINESS BRIEF:\n${briefLines.join('\n')}\n\n` : '';

    const styledPrompt = `${briefBlock}CREATIVE SEED: ${seed} (use as a randomness signal so repeat generations of the same business look visibly distinct).

USER REQUEST:
${prompt}`;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];
    if (Array.isArray(history)) {
      for (const m of history) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }
    messages.push({ role: 'user', content: styledPrompt });

    let html = '';
    try {
      const raw = await callOpenAI(apiKey, messages, 0.9, 16000);
      html = extractHtml(raw);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'openai_error', detail: String(err?.message ?? err) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Bug-review pass (default on; can be disabled via { review: false }).
    let reviewed = false;
    if (review !== false && html) {
      try {
        const reviewedHtml = await callOpenAI(
          apiKey,
          [
            { role: 'system', content: REVIEW_PROMPT },
            { role: 'user', content: html },
          ],
          0.2,
          16000,
        );
        const cleaned = extractHtml(reviewedHtml);
        if (cleaned && /<!DOCTYPE\s+html/i.test(cleaned)) {
          html = cleaned;
          reviewed = true;
        }
      } catch (_err) {
        // Reviewer is best-effort. Fall back to unreviewed HTML.
      }
    }

    // Resolve session: create one if not supplied.
    let resolvedSessionId: string | null = null;
    if (sessionId) {
      const { data: existing } = await supabase
        .from('chat_sessions')
        .select('id')
        .eq('id', sessionId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (existing) resolvedSessionId = existing.id;
    }
    if (!resolvedSessionId) {
      const title = (businessName ?? prompt).toString().slice(0, 60);
      const { data: created } = await supabase
        .from('chat_sessions')
        .insert({ user_id: user.id, title })
        .select('id')
        .single();
      resolvedSessionId = created?.id ?? null;
    } else {
      await supabase
        .from('chat_sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', resolvedSessionId);
    }

    const { data: site, error: siteErr } = await supabase
      .from('generated_sites')
      .insert({
        user_id: user.id,
        session_id: resolvedSessionId,
        business_name: businessName ?? null,
        business_type: businessType ?? null,
        client_location: clientLocation ?? null,
        html_output: html,
        status: 'pending',
      })
      .select()
      .single();
    if (siteErr) {
      return new Response(JSON.stringify({ error: siteErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await supabase
      .from('profiles')
      .update({ generations_used: (profile.generations_used ?? 0) + 1 })
      .eq('id', user.id);

    return new Response(
      JSON.stringify({
        site,
        html,
        sessionId: resolvedSessionId,
        reviewed,
        seed,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
