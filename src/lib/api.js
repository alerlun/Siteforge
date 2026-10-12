import { supabase } from './supabase.js';
import { isProUser } from './auth.jsx';

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

// generate-site sends a heartbeat every 5 s, so this long without any data means the
// connection is gone (e.g. the phone switched networks); stop instead of spinning.
const SSE_IDLE_TIMEOUT_MS = 45_000;

function readWithTimeout(reader) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Connection lost while generating. The site may still finish: reopen this chat in a minute before trying again.');
      err.status = 0;
      err.data = { error: 'stream_timeout' };
      reject(err);
    }, SSE_IDLE_TIMEOUT_MS);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

async function readSSE(res) {
  const reader = res.body.getReader();
  try {
    return await readEvents(reader);
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
}

async function readEvents(reader) {
  const decoder = new TextDecoder();
  let buf = '';
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await readWithTimeout(reader);
    if (done) {
      if (import.meta.env.DEV) console.warn('[readSSE] stream done. totalBytes:', totalBytes, 'buf tail:', JSON.stringify(buf.slice(-200)));
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    totalBytes += value.length;
    // Debug only: in production this logged every chunk, including HTML excerpts.
    if (import.meta.env.DEV) console.log('[readSSE] chunk', value.length, 'total', totalBytes, 'preview:', JSON.stringify(chunk.slice(0, 80)));

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

// Pro = plan 'pro' or an active referral reward (pro_until), same as the server.
export function planLimit(profile, kind) {
  const plan = isProUser(profile) ? 'pro' : 'free';
  return PLAN_LIMITS[plan][kind];
}
