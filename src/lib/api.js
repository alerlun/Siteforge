import { supabase } from './supabase.js';

async function authHeader() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function callFunction(name, body = {}) {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;
  const headers = {
    'Content-Type': 'application/json',
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    ...(await authHeader()),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Non-2xx: pre-stream error (auth, validation, rate limit, credit check, etc.)
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    const message = data?.error ?? `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  // SSE streaming endpoint — read until result or error event
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return readSSE(res);
  }

  // Plain JSON (other endpoints)
  return res.json();
}

async function readSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      console.warn('[readSSE] stream done. totalBytes:', totalBytes, 'buf tail:', JSON.stringify(buf.slice(-200)));
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    totalBytes += value.length;
    console.log('[readSSE] chunk', value.length, 'total', totalBytes, 'preview:', JSON.stringify(chunk.slice(0, 80)));

    buf += chunk;

    // SSE events are delimited by double newline (handle CRLF too)
    const events = buf.split(/\r?\n\r?\n/);
    buf = events.pop() ?? '';

    for (const block of events) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue;
        let parsed;
        try { parsed = JSON.parse(line.slice(6)); } catch (e) {
          console.error('[readSSE] JSON.parse failed, line length:', line.length, e);
          continue;
        }

        if (parsed.type === 'result') return parsed;
        if (parsed.type === 'error') {
          const e = new Error(parsed.error ?? 'Generation failed');
          e.status = parsed.status ?? 502;
          e.data = parsed;
          throw e;
        }
        // type === 'heartbeat': ignore, keeps connection alive
      }
    }
  }

  throw new Error('Stream ended without result');
}

export const PLAN_LIMITS = {
  free: { generations: 1, leads: 10 },
  pro: { generations: 10, leads: 100 },
};

export function planLimit(profile, kind) {
  const plan = profile?.plan === 'pro' ? 'pro' : 'free';
  return PLAN_LIMITS[plan][kind];
}
