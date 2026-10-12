import { corsHeaders } from '../_shared/cors.ts';
import { enforce } from '../_shared/ratelimit.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { errorResponse, fromHttpError } from '../_shared/guards.ts';

async function handle(req: Request): Promise<Response> {
  const user = await getUser(req);
  if (!user) return errorResponse(401, 'Unauthorized');

  const blocked = await enforce('referral', user.id);
  if (blocked) return blocked;

  const supabase = adminClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('referral_code')
    .eq('id', user.id)
    .single();

  if (profile?.referral_code) {
    return new Response(
      JSON.stringify({ code: profile.referral_code }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  let code: string | null = null;
  for (let i = 0; i < 10; i++) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 6)
      .toUpperCase();
    const candidate = `SF-${hex}`;

    const { error } = await supabase
      .from('profiles')
      .update({ referral_code: candidate })
      .eq('id', user.id)
      .is('referral_code', null);

    if (!error) { code = candidate; break; }
    if (error.code !== '23505') break; // non-collision error, stop retrying
    // else: unique collision, retry with new code
  }

  if (!code) return errorResponse(500, 'failed_to_generate');

  return new Response(
    JSON.stringify({ code }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

// Errors (e.g. HttpError from readBoundedJson, DB failures) become JSON responses
// instead of an unhandled 500 (AUDIT-APP.md L10).
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    return await handle(req);
  } catch (err) {
    console.error('[generate-referral-code]', err);
    return fromHttpError(err);
  }
});
