// delete-account — permanently deletes the caller's account and data.
// Order: cancel any Stripe subscription (so billing stops), detach users this account
// referred, then delete the auth user. Everything else cascades from auth.users ->
// profiles (leads, chat_sessions, chat_messages, generated_sites, credit_ledger,
// referral_activations); stripe_events.user_id is set null.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { getStripeConfig } from '../_shared/stripe.ts';
import { readBoundedJson, errorResponse, fromHttpError, clientIp } from '../_shared/guards.ts';
import { enforce } from '../_shared/ratelimit.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const user = await getUser(req);
    if (!user) return errorResponse(401, 'Unauthorized');

    const ipBlocked = await enforce('account', clientIp(req));
    if (ipBlocked) return ipBlocked;
    const userBlocked = await enforce('account', user.id);
    if (userBlocked) return userBlocked;

    // Explicit confirmation in the body, so a stray call cannot delete an account.
    const body = await readBoundedJson(req) as Record<string, unknown>;
    if (body?.confirm !== 'DELETE') return errorResponse(400, 'confirmation_required');

    const supabase = adminClient();
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('stripe_subscription_id')
      .eq('id', user.id)
      .maybeSingle();
    if (profileErr) throw new Error(`profile: ${profileErr.message}`);

    // Stop billing first. If Stripe fails, keep the account so the user is not charged
    // for a subscription nobody can reach any more.
    if (profile?.stripe_subscription_id) {
      const { secretKey } = await getStripeConfig();
      if (!secretKey) return errorResponse(500, 'stripe_not_configured');
      const res = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(profile.stripe_subscription_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${secretKey}` } },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // Already cancelled / unknown subscription: nothing left to bill.
        if (data?.error?.code !== 'resource_missing') {
          console.error('[delete-account] Stripe cancel failed:', user.id, res.status, data?.error?.message);
          return errorResponse(502, 'stripe_cancel_failed');
        }
      }
    }

    // profiles.referred_by has no ON DELETE action: detach referred users first.
    const { error: detachErr } = await supabase
      .from('profiles')
      .update({ referred_by: null })
      .eq('referred_by', user.id);
    if (detachErr) throw new Error(`detach referrals: ${detachErr.message}`);

    const { error: deleteErr } = await supabase.auth.admin.deleteUser(user.id);
    if (deleteErr) throw new Error(`delete user: ${deleteErr.message}`);

    console.log('[delete-account] deleted', user.id);
    return new Response(JSON.stringify({ deleted: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[delete-account]', err);
    return fromHttpError(err);
  }
});
