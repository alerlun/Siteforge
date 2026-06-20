import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, isProUser } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';
import { callFunction } from '../lib/api.js';
import { nextResetDate, formatDate } from '../lib/utils.js';
import { formatCredits, MONTHLY_ALLOWANCE } from '../lib/credits.js';
import { getReferralStats } from '../lib/referral.js';

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

  const isPro = isProUser(profile);
  const planLabel = isPro ? 'PRO PLAN' : 'FREE PLAN';
  const leadsLimit = isPro ? 100 : 10;
  const leadsUsed = profile?.leads_used ?? 0;
  const creditBalance = profile?.credit_balance ?? 0;
  const monthlyAllowance = MONTHLY_ALLOWANCE[isPro ? 'pro' : 'free'];

  const [ledger, setLedger] = useState([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);

  const [referral, setReferral] = useState(null);
  const [referralLoading, setReferralLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from('credit_ledger')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      if (active) { setLedger(data ?? []); setLedgerLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    getReferralStats().then((data) => {
      if (active) { setReferral(data); setReferralLoading(false); }
    }).catch(() => {
      if (active) setReferralLoading(false);
    });
    return () => { active = false; };
  }, []);

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

  function copyLink() {
    if (!referral?.link) return;
    navigator.clipboard.writeText(referral.link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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

      <div className="flex-1 overflow-auto px-5 py-5 space-y-5 max-w-3xl pb-14 md:pb-5">
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
            <UsageBar
              label="CREDITS"
              used={monthlyAllowance - creditBalance}
              limit={monthlyAllowance}
              formatValue={formatCredits}
            />
            <UsageBar label="LEADS" used={leadsUsed} limit={leadsLimit} />
          </div>
          <div className="mt-4 font-mono text-xs text-muted">
            Credits reset on {nextResetDate()}. Unused credits do not roll over.
          </div>
        </div>

        <div className="card">
          <div className="px-5 py-4 border-b border-border label">credit usage (last 20)</div>
          {ledgerLoading ? (
            <div className="p-4 font-mono text-xs text-muted">loading…</div>
          ) : ledger.length === 0 ? (
            <div className="p-4 font-mono text-xs text-muted">no usage yet.</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Credits</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.id}>
                    <td className="font-mono text-muted">{formatDate(row.created_at)}</td>
                    <td className="font-mono">{row.action_type}</td>
                    <td className="font-mono text-muted">{row.input_tokens.toLocaleString()}</td>
                    <td className="font-mono text-muted">{row.output_tokens.toLocaleString()}</td>
                    <td className="font-mono">{formatCredits(row.credits_charged)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="px-5 py-4 border-b border-border label">referral</div>
          {referralLoading ? (
            <div className="p-4 font-mono text-xs text-muted">loading…</div>
          ) : !referral ? (
            <div className="p-4 font-mono text-xs text-muted">unavailable</div>
          ) : (
            <div className="p-5 space-y-4">
              {referral.pro_until && new Date(referral.pro_until) > new Date() && (
                <div className="font-mono text-xs text-accent border border-accent/30 rounded px-3 py-2">
                  Pro active until {formatDate(referral.pro_until)} — earned via referrals
                </div>
              )}
              <div>
                <div className="label mb-2">your referral link</div>
                <div className="flex gap-2">
                  <input
                    readOnly
                    className="input font-mono text-xs flex-1 min-w-0"
                    value={referral.link}
                    onFocus={(e) => e.target.select()}
                  />
                  <button className="btn shrink-0" onClick={copyLink}>
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <div>
                <div className="label mb-2">progress to next free Pro month</div>
                <div className="border border-border p-3">
                  <div className="flex items-center justify-between font-mono text-xs mb-2">
                    <span className="text-muted">REFERRALS</span>
                    <span>{referral.progressToNext}/5</span>
                  </div>
                  <div className="h-1.5 bg-bg border border-border">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${Math.min(100, (referral.progressToNext / 5) * 100)}%` }}
                    />
                  </div>
                  <div className="mt-2 font-mono text-xs text-muted">
                    {referral.count} confirmed referral{referral.count !== 1 ? 's' : ''} total
                  </div>
                </div>
              </div>
              {referral.activations?.length > 0 && (
                <div>
                  <div className="label mb-2">recent referrals</div>
                  <div className="space-y-1">
                    {referral.activations.slice(0, 5).map((a, i) => (
                      <div key={i} className="flex items-center justify-between font-mono text-xs border border-border px-3 py-2">
                        <span className="text-muted">{formatDate(a.created_at)}</span>
                        <span className={a.status === 'confirmed' ? 'text-accent' : 'text-muted'}>
                          {a.status === 'confirmed' ? 'confirmed' : 'pending'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="border-t border-border pt-4">
                <div className="label mb-2">share</div>
                <div className="flex gap-2">
                  <a
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`I'm using SiteForge to build AI-powered websites for local businesses. Join me: ${referral.link}`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn font-mono text-xs"
                  >
                    Twitter / X
                  </a>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(`Check out SiteForge — AI-generated websites for local businesses. Sign up here: ${referral.link}`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn font-mono text-xs"
                  >
                    WhatsApp
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="card p-5 space-y-3">
          <div className="label">account</div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-sm break-all">{user?.email}</div>
              <div className="font-mono text-xs text-muted mt-1 break-all">user id: {user?.id}</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="btn" disabled={busy} onClick={changePassword}>Change Password</button>
              <button className="btn" onClick={signOut}>Sign Out</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UsageBar({ label, used, limit, formatValue }) {
  const fmt = formatValue ?? ((n) => n);
  const pct = Math.min(100, limit ? (used / limit) * 100 : 0);
  return (
    <div className="border border-border p-3">
      <div className="flex items-center justify-between font-mono text-xs">
        <span className="text-muted">{label}</span>
        <span>{fmt(used)}/{fmt(limit)}</span>
      </div>
      <div className="mt-2 h-1.5 bg-bg border border-border">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
