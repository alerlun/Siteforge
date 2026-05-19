import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const navigate = useNavigate();

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setInfo('');
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/app/chat` },
    });
    setBusy(false);
    if (error) return setErr(error.message);
    if (data?.session) {
      navigate('/app/chat', { replace: true });
    } else {
      setInfo('Check your email to confirm your account.');
    }
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
    <div className="min-h-screen grid-bg flex items-center justify-center p-6">
      <div className="card p-8 w-full max-w-sm">
        <Link to="/" className="font-mono uppercase tracking-widest text-sm">
          Site<span className="text-accent">Forge</span>
        </Link>
        <h1 className="font-mono text-2xl mt-4 mb-6">Create account</h1>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <div className="label mb-1">Email</div>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <div className="label mb-1">Password</div>
            <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {err && <div className="font-mono text-xs text-accent">{err}</div>}
          {info && <div className="font-mono text-xs text-muted">{info}</div>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'creating…' : 'Sign Up'}</button>
        </form>
        <div className="my-6 flex items-center gap-3">
          <div className="flex-1 h-px bg-border" />
          <span className="label">or</span>
          <div className="flex-1 h-px bg-border" />
        </div>
        <button onClick={onGoogle} className="btn w-full">Continue with Google</button>
        <div className="mt-6 font-mono text-xs text-muted text-center">
          Have an account? <Link to="/login" className="text-accent">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
