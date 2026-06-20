import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { errorResponse, clientIp, readBoundedJson } from '../_shared/guards.ts';

const ONE_HOUR_MS = 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const user = await getUser(req);
  if (!user) return errorResponse(401, 'Unauthorized');

  const supabase = adminClient();

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('referred_by, created_at, signup_ip')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) return errorResponse(404, 'profile_not_found');

  // Already attributed — idempotent success.
  if (profile.referred_by) {
    return new Response(
      JSON.stringify({ ok: true, skipped: 'already_attributed' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Reject retroactive claims (must be within 1h of signup).
  const accountAge = Date.now() - new Date(profile.created_at).getTime();
  if (accountAge > ONE_HOUR_MS) {
    return errorResponse(400, 'claim_window_expired');
  }

  const body = await readBoundedJson(req) as Record<string, unknown>;
  const rawCode = body?.referral_code;
  if (!rawCode || typeof rawCode !== 'string') {
    return errorResponse(400, 'missing_referral_code');
  }
  const referralCode = rawCode.trim().toUpperCase();

  // Resolve referrer by code.
  const { data: referrer } = await supabase
    .from('profiles')
    .select('id, signup_ip')
    .eq('referral_code', referralCode)
    .maybeSingle();

  if (!referrer) return errorResponse(404, 'invalid_code');
  if (referrer.id === user.id) return errorResponse(400, 'self_referral');

  const ip = clientIp(req);
  const referrerIp = referrer.signup_ip?.toString() ?? null;
  const isDuplicateIp = ip !== 'unknown' && referrerIp !== null && ip === referrerIp;

  if (isDuplicateIp) {
    await supabase.from('referral_activations').insert({
      referrer_id: referrer.id,
      referred_id: user.id,
      status: 'rejected',
      reject_reason: 'duplicate_ip',
      signup_ip: ip,
    }).then(null, () => {}); // ignore unique violation
    return new Response(
      JSON.stringify({ ok: true, skipped: 'duplicate_ip' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Set referred_by on profile and store signup_ip.
  await supabase
    .from('profiles')
    .update({ referred_by: referrer.id, signup_ip: ip !== 'unknown' ? ip : null })
    .eq('id', user.id);

  // Insert activation row (unique constraint on referred_id makes this idempotent).
  const { error: insertErr } = await supabase.from('referral_activations').insert({
    referrer_id: referrer.id,
    referred_id: user.id,
    signup_ip: ip !== 'unknown' ? ip : null,
  });

  if (insertErr && insertErr.code !== '23505') {
    return errorResponse(500, 'insert_failed');
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
