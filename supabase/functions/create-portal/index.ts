// create-portal — creates a Stripe Billing Portal session.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { getStripeConfig } from '../_shared/stripe.ts';
import { readBoundedJson, errorResponse, fromHttpError, clientIp } from '../_shared/guards.ts';
import { createPortalSchema } from '../_shared/validation.ts';
import { enforce } from '../_shared/ratelimit.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const user = await getUser(req);
    if (!user) return errorResponse(401, 'Unauthorized');

    const ipBlocked = await enforce('portal', clientIp(req));
    if (ipBlocked) return ipBlocked;
    const userBlocked = await enforce('portal', user.id);
    if (userBlocked) return userBlocked;

    const raw = await readBoundedJson(req);
    const parsed = createPortalSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, 'invalid_input', parsed.error.flatten());
    const baseUrl = parsed.data.origin || req.headers.get('origin') || '';
    const { secretKey: stripeKey } = await getStripeConfig();
    if (!stripeKey) return errorResponse(500, 'STRIPE_SECRET_KEY not configured');
    const supabase = adminClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();
    if (!profile?.stripe_customer_id) return errorResponse(400, 'No Stripe customer on file');
    const params = new URLSearchParams();
    params.set('customer', profile.stripe_customer_id);
    params.set('return_url', `${baseUrl}/app/settings`);
    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: data?.error?.message ?? 'stripe_error' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ url: data.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return fromHttpError(err);
  }
});
