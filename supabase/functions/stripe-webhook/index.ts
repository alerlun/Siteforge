// stripe-webhook — verifies signature, updates profiles on subscription events.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient } from '../_shared/auth.ts';
import { getStripeConfig } from '../_shared/stripe.ts';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx), p.slice(idx + 1)];
    }),
  );
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  const ts = parseInt(t, 10);
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  return timingSafeEqual(expected, v1);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let secret = '';
  try {
    secret = (await getStripeConfig()).webhookSecret;
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const ok = await verifyStripeSignature(body, sig, secret);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response('bad json', { status: 400, headers: corsHeaders });
  }

  const supabase = adminClient();

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id ?? session.metadata?.supabase_user_id;
      if (userId) {
        await supabase
          .from('profiles')
          .update({
            plan: 'pro',
            stripe_customer_id: session.customer ?? null,
            stripe_subscription_id: session.subscription ?? null,
          })
          .eq('id', userId);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;
      if (customerId) {
        await supabase
          .from('profiles')
          .update({
            plan: 'free',
            stripe_customer_id: null,
            stripe_subscription_id: null,
          })
          .eq('stripe_customer_id', customerId);
      }
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
