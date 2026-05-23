// create-checkout — creates a Stripe Checkout session for the Pro plan.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, getUser } from '../_shared/auth.ts';
import { getStripeConfig } from '../_shared/stripe.ts';

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
    const { origin } = await req.json().catch(() => ({ origin: '' }));
    const baseUrl = origin || req.headers.get('origin') || '';
    const { secretKey: stripeKey, proPriceId: priceId } = await getStripeConfig();
    if (!stripeKey || !priceId) {
      return new Response(JSON.stringify({ error: 'Stripe env not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = adminClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, email')
      .eq('id', user.id)
      .single();

    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', `${baseUrl}/app/settings?upgraded=true`);
    params.set('cancel_url', `${baseUrl}/app/settings`);
    params.set('client_reference_id', user.id);
    params.set('allow_promotion_codes', 'true');
    if (profile?.stripe_customer_id) {
      params.set('customer', profile.stripe_customer_id);
    } else if (user.email) {
      params.set('customer_email', user.email);
    }
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
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
