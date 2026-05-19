import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';
import { callFunction, planLimit } from '../lib/api.js';
import { nextResetDate } from '../lib/utils.js';

export default function Settings() {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const [params, setParams] = useSearchParams();
  const upgraded = params.get('upgraded') === 'true';
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(upgraded ? 'Welcome to Pro. Your account has been upgraded.' : '');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (upgraded) {
      // Refresh once webhook has likely fired; clear flag from URL.
      const t = setTimeout(() => {
        refreshProfile();
        setParams({}, { replace: true });
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [upgraded, refreshProfile, setParams]);

  const isPro = profile?.plan === 'pro';
  const planLabel = isPro ? 'PRO PLAN' : 'FREE PLAN';
  const generationsLimit = planLimit(profile, 'generations');
  const leadsLimit = planLimit(profile, 'leads');
  const generationsUsed = profile?.generations_used ?? 0;
  const leadsUsed = profile?.leads_used ?? 0;

  async function startCheckout() {
    setBusy(true);
    setErr('');
    try {
      const { url } = await callFunction('create-checkout', { origin: window.location.origin });
      window.location.href = url;
    } catch (e) {
      setErr(e.message || 'Could not start checkout.');
      setBusy(false);
    }
  }

  async function openPortal() {
    setBusy(true);
    setErr('');
    try {
      const { url } = await callFunction('create-portal', { origin: window.location.origin });
      window.location.href = url;
    } catch (e) {
      setErr(e.message || 'Could not open billing portal.');
      setBusy(false);
    }
  }

  async function changePassword() {
    if (!user?.email) return;
    setBusy(true);
    setErr('');
    setInfo('');
    const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: `${window.location.origin}/login`,
    });
    setBusy(false);
    if (error) setErr(error.message);
    else setInfo('Password reset email sent.');
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b border-border h-14 px-5 flex items-center justify-between shrink-0">
        <div className="font-mono uppercase tracking-widest text-xs text-muted">settings</div>
      </header>

      <div className="flex-1 overflow-auto px-5 py-5 space-y-5 max-w-3xl">
        {info && <div className="card border-accent p-3 font-mono text-xs">{info}</div>}
        {err && <div className="card border-accent p-3 font-mono text-xs text-accent">{err}</div>}

        <div className="card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="label">current plan</div>
              <div className="mt-2 font-mono text-2xl">{planLabel}</div>
            </div>
            {isPro ? (
              <button className="btn" disabled={busy} onClick={openPortal}>Manage Billing</button>
            ) : (
              <button className="btn-primary" disabled={busy} onClick={startCheckout}>
                {busy ? '…' : 'Upgrade to Pro'}
              </button>
            )}
          </div>
          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
            <UsageBar label="GENERATIONS" used={generationsUsed} limit={generationsLimit} />
            <UsageBar label="LEADS" used={leadsUsed} limit={leadsLimit} />
          </div>
          <div className="mt-4 font-mono text-xs text-muted">
            Counters reset on {nextResetDate()}.
          </div>
        </div>

        <div className="card p-5 space-y-3">
          <div className="label">account</div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-mono text-sm">{user?.email}</div>
              <div className="font-mono text-xs text-muted mt-1">user id: {user?.id}</div>
            </div>
            <div className="flex gap-2">
              <button className="btn" disabled={busy} onClick={changePassword}>Change Password</button>
              <button className="btn" onClick={signOut}>Sign Out</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UsageBar({ label, used, limit }) {
  const pct = Math.min(100, limit ? (used / limit) * 100 : 0);
  return (
    <div className="border border-border p-3">
      <div className="flex items-center justify-between font-mono text-xs">
        <span className="text-muted">{label}</span>
        <span>{used}/{limit}</span>
      </div>
      <div className="mt-2 h-1.5 bg-bg border border-border">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
