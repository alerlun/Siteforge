// stripe.ts — mode switch. config.stripe_mode ('test' | 'live') picks which key set to use.
// In 'live' mode the live keys are mandatory: a missing live key throws — it never
// silently falls back to test keys.
import { adminClient } from './auth.ts';

export type StripeMode = 'test' | 'live';

export async function getStripeMode(): Promise<StripeMode> {
  const supabase = adminClient();
  const { data } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'stripe_mode')
    .maybeSingle();
  return data?.value === 'live' ? 'live' : 'test';
}

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export interface StripeConfig {
  mode: StripeMode;
  secretKey: string;
  proPriceId: string;
  webhookSecret: string;
}

export async function getStripeConfig(): Promise<StripeConfig> {
  const mode = await getStripeMode();
  if (mode === 'live') {
    // Live mode: live keys only. Missing key throws — no fallback to test.
    return {
      mode,
      secretKey: required('STRIPE_SECRET_KEY_LIVE'),
      proPriceId: required('STRIPE_PRO_PRICE_ID_LIVE'),
      webhookSecret: required('STRIPE_WEBHOOK_SECRET_LIVE'),
    };
  }
  // Test mode: prefer _TEST vars, fall back to legacy unsuffixed vars.
  return {
    mode,
    secretKey: Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? Deno.env.get('STRIPE_SECRET_KEY') ?? '',
    proPriceId: Deno.env.get('STRIPE_PRO_PRICE_ID_TEST') ?? Deno.env.get('STRIPE_PRO_PRICE_ID') ?? '',
    webhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET_TEST') ?? Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '',
  };
}
