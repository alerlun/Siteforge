// edit-element — surgical single-element edit via Claude.
// The client sends only the selected element's outerHTML + an instruction.
// We return just the updated element HTML; the client splices it back in and saves.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { readBoundedJson, errorResponse, fromHttpError, clientIp } from '../_shared/guards.ts';
import { enforce } from '../_shared/ratelimit.ts';
import { z } from 'https://esm.sh/zod@3.23.8';

const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_BODY_BYTES = 64 * 1024;

const editElementSchema = z.object({
  siteId:      z.string().uuid(),
  elementHtml: z.string().min(1).max(50_000),
  instruction: z.string().trim().min(1).max(2000),
  elementPath: z.string().max(500).optional().nullable(),
});

interface TokenUsage { input_tokens: number; output_tokens: number; }
interface CreditRates { inRate: number; outRate: number; margin: number; }

async function getCreditRates(supabase: ReturnType<typeof adminClient>): Promise<CreditRates> {
  const { data } = await supabase.from('config').select('key, value').in('key', [
    'credit_in_rate', 'credit_out_rate', 'credit_margin',
  ]);
  const m = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  return {
    inRate:  parseFloat(m.get('credit_in_rate')  ?? '1'),
    outRate: parseFloat(m.get('credit_out_rate') ?? '5'),
    margin:  parseFloat(m.get('credit_margin')   ?? '1.1'),
  };
}

function computeCredits(usage: TokenUsage, rates: CreditRates): number {
  return Math.ceil((usage.input_tokens * rates.inRate + usage.output_tokens * rates.outRate) * rates.margin);
}

async function callClaude(
  apiKey: string,
  system: string,
  userContent: string,
): Promise<{ text: string; usage: TokenUsage }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) { const d = await res.text(); throw new Error(`anthropic_error: ${res.status} ${d}`); }
  const payload = await res.json();
  const blocks = (payload?.content as Array<{ type: string; text?: string }>) ?? [];
  let text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  // Strip code fences if model wrapped output despite instructions.
  const fenceMatch = text.match(/^```(?:html)?\s*([\s\S]*?)```\s*$/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  return {
    text,
    usage: {
      input_tokens:  payload?.usage?.input_tokens  ?? 0,
      output_tokens: payload?.usage?.output_tokens ?? 0,
    },
  };
}

const SYSTEM_PROMPT = `You are an expert web developer editing a single HTML element or section. You receive the element's current HTML and a change instruction.

RULES:
- Apply ONLY what the change request asks. Do not change surrounding elements, class names not mentioned, or unrelated attributes.
- Preserve existing structure, classes, and content unless the instruction explicitly changes them.
- Return ONLY the updated HTML element — no explanation, no code fences, no surrounding tags, no doctype.
- The output must be a valid HTML fragment that can replace the original element in the page.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const user = await getUser(req);
    if (!user) return errorResponse(401, 'Unauthorized');

    const ipBlocked = await enforce('generate', clientIp(req));
    if (ipBlocked) return ipBlocked;
    const userBlocked = await enforce('generate', user.id);
    if (userBlocked) return userBlocked;

    const raw = await readBoundedJson(req, MAX_BODY_BYTES);
    const parsed = editElementSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, 'invalid_input', parsed.error.flatten());
    const { siteId, elementHtml, instruction, elementPath } = parsed.data;

    const supabase = adminClient();

    // Verify the user owns this site.
    const { data: site, error: siteErr } = await supabase
      .from('generated_sites')
      .select('id, user_id')
      .eq('id', siteId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (siteErr || !site) return errorResponse(404, 'site_not_found');

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return errorResponse(500, 'ANTHROPIC_API_KEY not configured');

    // Atomically withhold the estimate (~500 input + 3000 output) before the AI call.
    // NULL = balance too low. Settled to the real cost on success, refunded on failure.
    const rates = await getCreditRates(supabase);
    const estimate = computeCredits({ input_tokens: 500, output_tokens: 3000 }, rates);
    const { data: reservationId, error: reserveErr } = await supabase.rpc('reserve_credits', {
      p_user_id: user.id, p_amount: estimate, p_action: 'element_edit',
    });
    if (reserveErr) throw new Error(`reserve_credits: ${reserveErr.message}`);
    if (!reservationId) {
      const { data: profile } = await supabase.from('profiles').select('credit_balance').eq('id', user.id).single();
      return errorResponse(402, 'insufficient_credits', { balance: Number(profile?.credit_balance ?? 0), estimate });
    }

    const pathNote = elementPath ? `\nLOCATION (CSS path): ${elementPath}` : '';
    const userContent = `CURRENT ELEMENT:${pathNote}\n${elementHtml}\n\nCHANGE REQUEST:\n${instruction}`;

    let updatedHtml: string;
    let usage: TokenUsage;
    try {
      ({ text: updatedHtml, usage } = await callClaude(apiKey, SYSTEM_PROMPT, userContent));
    } catch (err) {
      // The AI call failed: give the reserved estimate back.
      const { error: refundErr } = await supabase.rpc('refund_credits', { p_ledger_id: reservationId });
      if (refundErr) console.error('[edit-element] refund_credits failed:', reservationId, refundErr.message);
      throw err;
    }

    // Settle to the real cost (balance + ledger in one transaction). The edit is done,
    // so a settle failure is logged, not returned; the user has then paid the estimate.
    const credits = computeCredits(usage, rates);
    const { error: settleErr } = await supabase.rpc('settle_credits', {
      p_ledger_id: reservationId,
      p_credits: credits,
      p_input_tokens: usage.input_tokens,
      p_output_tokens: usage.output_tokens,
      p_cache_write_tokens: 0,
      p_cache_read_tokens: 0,
      p_site_id: siteId,
    });
    if (settleErr) console.error('[edit-element] settle_credits failed:', reservationId, settleErr.message);

    return new Response(
      JSON.stringify({ updatedHtml, creditsUsed: credits }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return fromHttpError(err);
  }
});
