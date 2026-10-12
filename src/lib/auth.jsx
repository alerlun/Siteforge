import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from './supabase.js';

// Background refreshes (tab focus, route change) are skipped if the profile was
// loaded less than this long ago.
const REFRESH_THROTTLE_MS = 2000;

const AuthCtx = createContext({
  user: null,
  profile: null,
  loading: true,
  refreshProfile: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // Each load gets a sequence number; only the newest response is applied, so a slow
  // older request can't overwrite a newer balance.
  const loadSeq = useRef(0);
  const lastLoadAt = useRef(0);

  const loadProfile = useCallback(async (uid, retry = true) => {
    const seq = ++loadSeq.current;
    if (!uid) {
      setProfile(null);
      return;
    }
    // A different user signed in: never keep showing the previous user's profile.
    setProfile((prev) => (prev && prev.id !== uid ? null : prev));
    lastLoadAt.current = Date.now();
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', uid)
      .maybeSingle();
    if (seq !== loadSeq.current) return;
    if (error) {
      // Keep this user's last known profile on a transient error instead of showing
      // 0 credits, and try once more.
      console.error('[auth] profile load failed', error);
      if (retry) {
        await new Promise((r) => setTimeout(r, 1500));
        if (seq === loadSeq.current) await loadProfile(uid, false);
      }
    } else {
      setProfile(data);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!active) return;
      setUser(session?.user ?? null);
      await loadProfile(session?.user?.id);
      setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      loadProfile(session?.user?.id);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (user?.id) await loadProfile(user.id);
  }, [user, loadProfile]);

  // The balance changes outside this tab (monthly reset, Stripe webhook, other tabs,
  // dashboard edits). Re-read it when the tab regains focus and on every route change.
  const backgroundRefresh = useCallback(() => {
    if (!user?.id || Date.now() - lastLoadAt.current < REFRESH_THROTTLE_MS) return;
    loadProfile(user.id);
  }, [user, loadProfile]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') backgroundRefresh(); };
    window.addEventListener('focus', backgroundRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', backgroundRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [backgroundRefresh]);

  const { pathname } = useLocation();
  useEffect(() => { backgroundRefresh(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    loadSeq.current++; // drop any profile load still in flight
    setUser(null);
    setProfile(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ user, profile, loading, refreshProfile, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}

export function isProUser(profile) {
  if (!profile) return false;
  if (profile.plan === 'pro') return true;
  if (profile.pro_until && new Date(profile.pro_until) > new Date()) return true;
  return false;
}
