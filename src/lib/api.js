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
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const message = data?.error ?? `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const PLAN_LIMITS = {
  free: { generations: 1, leads: 10 },
  pro: { generations: 10, leads: 100 },
};

export function planLimit(profile, kind) {
  const plan = profile?.plan === 'pro' ? 'pro' : 'free';
  return PLAN_LIMITS[plan][kind];
}
