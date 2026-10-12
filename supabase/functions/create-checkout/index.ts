// create-checkout — creates a Stripe Checkout session for the Pro plan.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { getStripeConfig } from '../_shared/stripe.ts';
import { readBoundedJson, errorResponse, fromHttpError, clientIp } from '../_shared/guards.ts';
import { createCheckoutSchema } from '../_shared/validation.ts';
import { enforce } from '../_shared/ratelimit.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const user = await getUser(req);
    if (!user) return errorResponse(401, 'Unauthorized');

    const ipBlocked = await enforce('checkout', clientIp(req));
    if (ipBlocked) return ipBlocked;
    const userBlocked = await enforce('checkout', user.id);
    if (userBlocked) return userBlocked;

    const raw = await readBoundedJson(req);
    const parsed = createCheckoutSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, 'invalid_input', parsed.error.flatten());
    const baseUrl = parsed.data.origin || req.headers.get('origin') || '';
    const { secretKey: stripeKey, proPriceId: priceId } = await getStripeConfig();
    if (!stripeKey || !priceId) return errorResponse(500, 'Stripe env not configured');

    const supabase = adminClient();
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('plan, stripe_customer_id, stripe_subscription_id')
      .eq('id', user.id)
      .single();
    if (profileErr || !profile) return errorResponse(404, 'profile_not_found');

    // One subscription per account: a second checkout (two tabs, double click before the
    // webhook lands) would start a second subscription that is billed every month.
    if (profile.plan === 'pro' && profile.stripe_subscription_id) {
      return errorResponse(409, 'already_subscribed');
    }

    // Create the Stripe customer before the session and store it, so every checkout for
    // this account uses the same customer. With customer_email each session created its
    // own customer, and a subscription on a customer the profile no longer pointed at
    // could not be seen or cancelled in the Billing Portal.
    let customerId: string | null = profile.stripe_customer_id ?? null;
    if (!customerId) {
      const cParams = new URLSearchParams();
      if (user.email) cParams.set('email', user.email);
      cParams.set('metadata[supabase_user_id]', user.id);
      const cRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Concurrent requests for the same user get the same customer back.
          'Idempotency-Key': `siteforge-customer-${user.id}`,
        },
        body: cParams.toString(),
      });
      const customer = await cRes.json();
      if (!cRes.ok || !customer?.id) {
        return errorResponse(502, customer?.error?.message ?? 'stripe_customer_error');
      }
      // Only fill an empty slot; if a parallel request stored one first, use that one.
      const { data: stored, error: storeErr } = await supabase
        .from('profiles')
        .update({ stripe_customer_id: customer.id })
        .eq('id', user.id)
        .is('stripe_customer_id', null)
        .select('stripe_customer_id');
      if (storeErr) throw new Error(`store stripe_customer_id: ${storeErr.message}`);
      if (stored && stored.length) {
        customerId = customer.id;
      } else {
        const { data: again } = await supabase
          .from('profiles').select('stripe_customer_id').eq('id', user.id).single();
        customerId = again?.stripe_customer_id ?? customer.id;
      }
    }

    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', `${baseUrl}/app/settings?upgraded=true`);
    params.set('cancel_url', `${baseUrl}/app/settings`);
    params.set('client_reference_id', user.id);
    params.set('allow_promotion_codes', 'true');
    if (!customerId) return errorResponse(502, 'stripe_customer_error');
    params.set('customer', customerId);
    params.set('metadata[supabase_user_id]', user.id);

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: data?.error?.message ?? 'stripe_error', detail: data }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ url: data.url, id: data.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return fromHttpError(err);
  }
});
