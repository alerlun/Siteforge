import { corsHeaders } from '../_shared/cors.ts';
import { enforce } from '../_shared/ratelimit.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { errorResponse, fromHttpError } from '../_shared/guards.ts';

const APP_URL = Deno.env.get('APP_URL') ?? 'https://siteforge-vert.vercel.app';

async function handle(req: Request): Promise<Response> {
  const user = await getUser(req);
  if (!user) return errorResponse(401, 'Unauthorized');

  const blocked = await enforce('referral', user.id);
  if (blocked) return blocked;

  const supabase = adminClient();

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('referral_code, referral_count, referral_milestone, pro_until')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) return errorResponse(404, 'profile_not_found');

  const { data: activations } = await supabase
    .from('referral_activations')
    .select('status, first_generation_at, confirmed_at, created_at')
    .eq('referrer_id', user.id)
    .neq('status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(20);

  const count = profile.referral_count ?? 0;
  const milestone = profile.referral_milestone ?? 0;
  const nextMilestone = milestone + 5;

  return new Response(
    JSON.stringify({
      code: profile.referral_code,
      link: `${APP_URL}/signup?ref=${profile.referral_code}`,
      count,
      milestone,
      nextMilestone,
      progressToNext: count - milestone,
      pro_until: profile.pro_until ?? null,
      activations: activations ?? [],
    }),
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
    console.error('[referral-stats]', err);
    return fromHttpError(err);
  }
});
