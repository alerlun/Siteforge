import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';

// Landing page for the password-reset email (resetPasswordForEmail redirectTo). supabase-js
// reads the recovery token from the URL and signs the user in with a recovery session;
// this page then lets them choose a new password with updateUser().
export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let active = true;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY' || session) setReady(true);
    });
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      if (session) setReady(true);
      setChecked(true);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setErr('');
    if (password !== confirm) {
      setErr('Passwords do not match.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    navigate('/app/chat', { replace: true });
  }

  return (
    <div className="min-h-screen grid-bg flex items-center justify-center p-6">
      <div className="card p-8 w-full max-w-sm">
        <Link to="/" className="font-mono uppercase tracking-widest text-sm">
          Site<span className="text-accent">Forge</span>
        </Link>
        <h1 className="font-mono text-2xl mt-4 mb-6">Choose a new password</h1>
        {ready ? (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <div className="label mb-1">New password</div>
              <input className="input" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div>
              <div className="label mb-1">Confirm password</div>
              <input className="input" type="password" required minLength={6} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {err && <div className="font-mono text-xs text-accent">{err}</div>}
            <button className="btn-primary w-full" disabled={busy}>{busy ? 'saving…' : 'Save Password'}</button>
          </form>
        ) : checked ? (
          <div className="font-mono text-xs text-muted space-y-4">
            <p>This reset link is invalid or has expired.</p>
            <Link to="/login" className="text-accent">Request a new one from the sign-in page</Link>
          </div>
        ) : (
          <div className="font-mono text-xs text-muted">checking link…</div>
        )}
      </div>
    </div>
  );
}
