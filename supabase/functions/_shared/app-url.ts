// Where Stripe sends the user back (success/cancel/return URLs).
//
// The client sends its origin, but a client-chosen URL makes Stripe an open redirect
// (AUDIT-APP.md L8). Only known origins are used: APP_URL (secret, defaults to the
// production site), any origins listed in ALLOWED_ORIGINS (comma-separated, e.g.
// preview domains) and the local dev server. Anything else falls back to APP_URL.

const APP_URL = (Deno.env.get('APP_URL') ?? 'https://siteforge-vert.vercel.app').replace(/\/+$/, '');

const allowed = new Set(
  [
    APP_URL,
    'http://localhost:5173',
    ...(Deno.env.get('ALLOWED_ORIGINS') ?? '').split(','),
  ]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
);

export function appBaseUrl(requested: string | null | undefined): string {
  const origin = (requested ?? '').trim().replace(/\/+$/, '');
  return allowed.has(origin) ? origin : APP_URL;
}
