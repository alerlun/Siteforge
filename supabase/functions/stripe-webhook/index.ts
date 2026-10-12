// stripe-webhook — verifies signature, updates plan/credits on subscription events.
// Handled: checkout.session.completed, checkout.session.async_payment_succeeded,
// invoice.paid (subscription_cycle), customer.subscription.deleted. The Stripe endpoint
// must be subscribed to all four.
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient } from '../_shared/auth.ts';
import { getStripeConfig } from '../_shared/stripe.ts';
import { readBoundedText, errorResponse, fromHttpError } from '../_shared/guards.ts';

const MAX_WEBHOOK_BYTES = 512 * 1024; // Stripe events can be large (invoices, many line items)

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
  // The header can carry several v1 signatures (e.g. while a secret is being rolled),
  // so collect all of them rather than keeping only the last (AUDIT-APP.md L6).
  let t = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!t || !signatures.length) return false;
  const ts = parseInt(t, 10);
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  return signatures.some((sig) => timingSafeEqual(expected, sig));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // No IP rate limit: Stripe sends from shared IPs, so bursts got 429 and delayed
  // upgrades. The signature check below is the protection (AUDIT-APP.md L7).

  let body: string;
  try {
    body = await readBoundedText(req, MAX_WEBHOOK_BYTES);
  } catch (err) {
    return fromHttpError(err);
  }
  const sig = req.headers.get('stripe-signature');

  // Verify with the active mode's secret, then with the other mode's. Events from the
  // other mode used to be rejected and retried by Stripe for days; they are now
  // acknowledged but not applied, so test payments never change live data
  // (AUDIT-APP.md L5).
  let activeMode: 'test' | 'live';
  let activeSecret = '';
  try {
    const cfg = await getStripeConfig();
    activeMode = cfg.mode;
    activeSecret = cfg.webhookSecret;
  } catch (err) {
    return fromHttpError(err);
  }
  const otherSecret = activeMode === 'live'
    ? (Deno.env.get('STRIPE_WEBHOOK_SECRET_TEST') ?? Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '')
    : (Deno.env.get('STRIPE_WEBHOOK_SECRET_LIVE') ?? '');

  let fromOtherMode = false;
  if (!(await verifyStripeSignature(body, sig, activeSecret))) {
    if (otherSecret && (await verifyStripeSignature(body, sig, otherSecret))) {
      fromOtherMode = true;
    } else {
      return errorResponse(400, 'invalid signature');
    }
  }

  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return errorResponse(400, 'bad json');
  }

  if (fromOtherMode || (typeof event.livemode === 'boolean' && event.livemode !== (activeMode === 'live'))) {
    console.log('[stripe-webhook] ignoring event from the inactive Stripe mode:', event.type, event.id);
    return new Response(JSON.stringify({ received: true, ignored: 'inactive_mode' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = adminClient();

  // supabase-js returns { error } instead of throwing. Any DB error must surface as a
  // non-2xx response so Stripe retries the event; the RPCs are idempotent per event id.
  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      // Upgrade: plan = 'pro' + top up to the Pro allowance (stripe_apply_checkout).
      // With delayed payment methods (SEPA, Klarna, ...) 'completed' arrives with
      // payment_status 'unpaid'; the upgrade then waits for 'async_payment_succeeded'.
      // A failed delayed payment ('async_payment_failed') never upgrades, so it needs no handling.
      const session = event.data.object;
      const userId = session.client_reference_id ?? session.metadata?.supabase_user_id;
      const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
      if (!paid) {
        console.log('[stripe-webhook] checkout not paid yet, waiting:', event.id, session.payment_status);
      } else if (userId) {
        const { error } = await supabase.rpc('stripe_apply_checkout', {
          p_event_id: event.id,
          p_user_id: userId,
          p_customer_id: session.customer ?? null,
          p_subscription_id: session.subscription ?? null,
        });
        if (error) throw new Error(`stripe_apply_checkout: ${error.message}`);
      }
    } else if (event.type === 'invoice.paid') {
      // Renewal: top up for the new billing period. The first invoice of a subscription
      // ('subscription_create') is already covered by checkout.session.completed.
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_cycle' && invoice.customer) {
        const { error } = await supabase.rpc('stripe_apply_renewal', {
          p_event_id: event.id,
          p_customer_id: invoice.customer,
        });
        if (error) throw new Error(`stripe_apply_renewal: ${error.message}`);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      // Downgrade. The remaining balance is kept until the next monthly reset.
      // Failed payments are not handled: Stripe retries, then sends this event.
      // Only the subscription the profile points at downgrades it: if a customer ever has
      // a second (stray) subscription, cancelling that one must not end an active Pro.
      const sub = event.data.object;
      const customerId = sub.customer;
      if (customerId && sub.id) {
        const { error } = await supabase
          .from('profiles')
          .update({
            plan: 'free',
            stripe_customer_id: null,
            stripe_subscription_id: null,
          })
          .eq('stripe_customer_id', customerId)
          .eq('stripe_subscription_id', sub.id);
        if (error) throw new Error(`downgrade: ${error.message}`);
      }
    }
  } catch (err) {
    console.error('[stripe-webhook]', event.type, event.id, err);
    return fromHttpError(err);
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
