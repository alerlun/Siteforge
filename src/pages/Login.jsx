import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  async function onEmailSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    const next = location.state?.from || '/app/chat';
    navigate(next, { replace: true });
  }

  async function onGoogle() {
    setErr('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/app/chat` },
    });
    if (error) setErr(error.message);
  }

  return (
    <AuthShell title="Sign in">
      <form onSubmit={onEmailSubmit} className="space-y-4">
        <div>
          <div className="label mb-1">Email</div>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Password</div>
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <div className="font-mono text-xs text-accent">{err}</div>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'signing in…' : 'Sign In'}</button>
      </form>
      <div className="my-6 flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="label">or</span>
        <div className="flex-1 h-px bg-border" />
      </div>
      <button onClick={onGoogle} className="btn w-full">Continue with Google</button>
      <div className="mt-6 font-mono text-xs text-muted text-center">
        No account? <Link to="/signup" className="text-accent">Sign up</Link>
      </div>
    </AuthShell>
  );
}

function AuthShell({ title, children }) {
  return (
    <div className="min-h-screen grid-bg flex items-center justify-center p-6">
      <div className="card p-8 w-full max-w-sm">
        <Link to="/" className="font-mono uppercase tracking-widest text-sm">
          Site<span className="text-accent">Forge</span>
        </Link>
        <h1 className="font-mono text-2xl mt-4 mb-6">{title}</h1>
        {children}
      </div>
    </div>
  );
}
