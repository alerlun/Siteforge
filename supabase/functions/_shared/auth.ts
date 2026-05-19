import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? Deno.env.get('VITE_SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );
}

export async function getUser(req: Request) {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const supabase = adminClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export const PLAN_LIMITS = {
  free: { generations: 3, leads: 100 },
  pro: { generations: 10, leads: 1000 },
} as const;
