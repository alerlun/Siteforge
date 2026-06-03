import { adminClient } from './auth.ts';
import { corsHeaders } from './cors.ts';

// Rate limiting backed by Postgres (Supabase) — no external Redis dependency.
// Each limiter is a fixed-window counter enforced atomically by the check_rate_limit()
// SQL function (see supabase/schema.sql), called through the service-role client.
//
// Fail-open policy: if the DB call errors (outage, migration not yet applied), the
// request is ALLOWED and the error is logged. We favour availability over hard-blocking
// legitimate traffic; the per-plan monthly caps and Supabase Auth rate limits remain in
// force regardless. Unlike the previous Redis limiter, there is no "unconfigured =
// silently off" state: once schema.sql is applied the limiter is always active.

interface LimitConfig {
  limit: number;
  windowSeconds: number;
  prefix: string;
}

export const limiters = {
  generate: { limit: 10, windowSeconds: 60, prefix: 'gen' },
  scrape: { limit: 20, windowSeconds: 60, prefix: 'scrape' },
  checkout: { limit: 10, windowSeconds: 60, prefix: 'checkout' },
  portal: { limit: 10, windowSeconds: 60, prefix: 'portal' },
  webhook: { limit: 120, windowSeconds: 60, prefix: 'webhook' },
} as const satisfies Record<string, LimitConfig>;

export type LimiterName = keyof typeof limiters;

interface RateLimitRow {
  allowed: boolean;
  remaining: number;
  reset_at: string;
}

export async function enforce(name: LimiterName, key: string): Promise<Response | null> {
  const cfg = limiters[name];
  const fullKey = `${cfg.prefix}:${key}`;

  let allowed = true;
  let remaining = cfg.limit;
  let resetAt = Date.now() + cfg.windowSeconds * 1000;

  try {
    const { data, error } = await adminClient().rpc('check_rate_limit', {
      p_key: fullKey,
      p_limit: cfg.limit,
      p_window_seconds: cfg.windowSeconds,
    });
    if (error) {
      console.error('ratelimit_error', name, error.message);
      return null; // fail open
    }
    const row = (Array.isArray(data) ? data[0] : data) as RateLimitRow | undefined;
    if (row) {
      allowed = row.allowed;
      remaining = row.remaining ?? 0;
      if (row.reset_at) resetAt = new Date(row.reset_at).getTime();
    }
  } catch (err) {
    console.error('ratelimit_error', name, err);
    return null; // fail open
  }

  if (allowed) return null;

  const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return new Response(
    JSON.stringify({ error: 'rate_limited', retryAfterSeconds: retryAfterSec }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(cfg.limit),
        'X-RateLimit-Remaining': String(remaining),
      },
    },
  );
}
