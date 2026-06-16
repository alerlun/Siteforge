import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';
import { callFunction } from '../lib/api.js';
import { downloadHtml } from '../lib/utils.js';
import { estimateCredits, formatCredits, MONTHLY_ALLOWANCE } from '../lib/credits.js';
import SaleModal from '../components/SaleModal.jsx';
import SessionsPanel from '../components/SessionsPanel.jsx';

export default function Chat() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const initialPrompt = location.state?.prompt ?? '';
  const initialMeta = location.state?.meta ?? null;
  const initialLeadId = location.state?.leadId ?? null;

  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(initialPrompt);
  const [meta, setMeta] = useState(initialMeta);
  const [leadId, setLeadId] = useState(initialLeadId);
  const [html, setHtml] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [latestSite, setLatestSite] = useState(null);
  const [busy, setBusy] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const [error, setError] = useState('');
  const [saleOpen, setSaleOpen] = useState(false);
  const [sidebarW, setSidebarW] = useState(224);
  const [genW, setGenW] = useState(620);
  const threadRef = useRef(null);

  const creditBalance = profile?.credit_balance ?? 0;
  const monthlyAllowance = MONTHLY_ALLOWANCE[profile?.plan === 'pro' ? 'pro' : 'free'];
  const genEstimate = estimateCredits(html ? 'edit' : 'generation');
  const canGenerate = creditBalance >= genEstimate;
  const planLabel = profile?.plan === 'pro' ? '[PRO]' : '[FREE]';

  // Load sessions on mount.
  const loadSessions = useCallback(async () => {
    if (!user?.id) return;
    setSessionsLoading(true);
    const { data, error: err } = await supabase
      .from('chat_sessions')
      .select('id, title, lead_id, created_at, updated_at')
      .order('updated_at', { ascending: false });
    setSessionsLoading(false);
    if (err) {
      console.error(err);
      return;
    }
    setSessions(data ?? []);
  }, [user?.id]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Render the AI-generated site through a blob: URL rather than srcDoc. Two reasons:
  // (1) A blob document does NOT inherit the app's Content-Security-Policy, so generated
  //     sites can freely use their own inline scripts, fonts, and external images.
  // (2) Combined with a sandbox that omits `allow-same-origin`, the preview runs in an
  //     opaque origin and cannot read the parent's localStorage — where the Supabase
  //     session token lives. This stops generated/edited HTML from exfiltrating the
  //     user's auth token (XSS / token theft). The URL is revoked when html changes.
  useEffect(() => {
    if (!html) { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  // Pick the default session once sessions load.
  // - Arrived from a lead: open that lead's existing chat if one exists;
  //   otherwise leave activeSessionId null so the first generate creates one
  //   tied to the lead — never hijack an unrelated recent chat.
  // - Arrived plain: open the most recent session.
  useEffect(() => {
    if (sessionsLoading) return;
    if (activeSessionId) return;
    if (sessions.length === 0) return;
    if (initialLeadId) {
      const match = sessions.find((s) => s.lead_id === initialLeadId);
      if (match) selectSession(match.id);
      return;
    }
    selectSession(sessions[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsLoading, sessions]);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, busy]);

  async function selectSession(id) {
    setActiveSessionId(id);
    setLeadId(sessions.find((s) => s.id === id)?.lead_id ?? null);
    setMessages([]);
    setHtml('');
    setLatestSite(null);
    setError('');
    setLimitHit(false);
    if (!id) return;
    const [{ data: msgs }, { data: sites }] = await Promise.all([
      supabase.from('chat_messages').select('*').eq('session_id', id).order('created_at'),
      supabase.from('generated_sites').select('*').eq('session_id', id).order('created_at', { ascending: false }).limit(1),
    ]);
    setMessages(
      (msgs ?? []).map((m) => ({ role: m.role, content: m.content, siteId: m.site_id })),
    );
    if (sites && sites.length) {
      setLatestSite(sites[0]);
      setHtml(sites[0].html_output ?? '');
      setMeta({
        businessName: sites[0].business_name,
        businessType: sites[0].business_type,
        clientLocation: sites[0].client_location,
      });
    }
  }

  function newSession() {
    setActiveSessionId(null);
    setLeadId(null);
    setMessages([]);
    setHtml('');
    setLatestSite(null);
    setError('');
    setLimitHit(false);
    setMeta(initialMeta);
  }

  async function deleteSession(id) {
    await supabase.from('chat_sessions').delete().eq('id', id);
    if (id === activeSessionId) {
      setActiveSessionId(null);
      setMessages([]);
      setHtml('');
      setLatestSite(null);
    }
    loadSessions();
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    setError('');
    setLimitHit(false);
    if (!canGenerate) {
      setLimitHit(true);
      return;
    }
    const userContent = input.trim();
    const userMsg = { role: 'user', content: userContent };
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setBusy(true);

    // Persist the user message immediately (will get a session_id once function returns).
    let userMsgRow = null;
    if (activeSessionId) {
      const { data } = await supabase
        .from('chat_messages')
        .insert({ session_id: activeSessionId, user_id: user.id, role: 'user', content: userContent })
        .select()
        .single();
      userMsgRow = data;
    }

    try {
      const data = await callFunction('generate-site', {
        prompt: userContent,
        businessName: meta?.businessName ?? null,
        businessType: meta?.businessType ?? null,
        clientLocation: meta?.clientLocation ?? null,
        history,
        sessionId: activeSessionId,
        leadId,
        currentHtml: html || null,
      });

      const newSessionId = data.sessionId;
      const site = data.site;
      const reviewedNote = data.reviewed ? ' (reviewed)' : '';
      const assistantContent = data.edited
        ? `Updated the site${reviewedNote}.`
        : site?.business_name
          ? `Generated site for "${site.business_name}"${reviewedNote}.`
          : `Generated site${reviewedNote}.`;

      // Backfill session linkage if it was just created server-side.
      if (newSessionId && newSessionId !== activeSessionId) {
        setActiveSessionId(newSessionId);
        if (userMsgRow) {
          await supabase
            .from('chat_messages')
            .update({ session_id: newSessionId })
            .eq('id', userMsgRow.id);
        } else {
          await supabase
            .from('chat_messages')
            .insert({ session_id: newSessionId, user_id: user.id, role: 'user', content: userContent });
        }
      }

      const sessionToUse = newSessionId ?? activeSessionId;
      if (sessionToUse) {
        await supabase.from('chat_messages').insert({
          session_id: sessionToUse,
          user_id: user.id,
          role: 'assistant',
          content: assistantContent,
          site_id: site?.id ?? null,
        });
      }

      setHtml(data.html);
      setLatestSite(site);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: assistantContent, siteId: site?.id },
      ]);
      await refreshProfile();
      loadSessions();
    } catch (err) {
      if (err.status === 402) {
        setLimitHit(true);
      } else {
        const detail = err.data?.detail;
        setError(detail ? `${err.message}: ${detail}` : (err.message || 'Generation failed.'));
      }
    } finally {
      setBusy(false);
    }
  }

  const businessForFile = latestSite?.business_name || meta?.businessName || 'site';

  function openFullscreen() {
    if (!html) return;
    // Open via a blob: URL rather than document.write into about:blank. `noopener`
    // severs the new tab's access to window.opener (prevents reverse tabnabbing by the
    // generated page). Revoke after a delay so the navigation has completed.
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return (
    <div className="flex h-screen">
      <SessionsPanel
        sessions={sessions}
        activeId={activeSessionId}
        loading={sessionsLoading}
        onSelect={selectSession}
        onNew={newSession}
        onDelete={deleteSession}
        width={sidebarW}
      />
      <Divider onDrag={(dx) => setSidebarW((w) => clamp(w + dx, 160, 420))} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="border-b border-border h-14 px-5 flex items-center justify-between shrink-0">
          <div className="font-mono uppercase tracking-widest text-xs text-muted">
            generator
          </div>
          <div className="flex items-center gap-3">
            <span className="badge border-border text-text">{planLabel}</span>
            <button
              className="font-mono text-xs uppercase tracking-wider text-muted hover:text-accent"
              onClick={() => navigate('/app/settings')}
              title={`${formatCredits(creditBalance)} / ${formatCredits(monthlyAllowance)} credits remaining`}
            >
              Credits: {formatCredits(creditBalance)}
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 flex">
          <section className="flex flex-col min-h-0 shrink-0" style={{ width: genW }}>
            <div ref={threadRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
              {messages.length === 0 && !busy && <EmptyState />}
              {messages.map((m, i) => (
                <Message key={i} role={m.role} content={m.content} />
              ))}
              {busy && <TypingIndicator />}
              {limitHit && (
                <div className="card border-accent p-4 font-mono text-sm">
                  Not enough credits. Balance: {formatCredits(creditBalance)}.{' '}
                  {profile?.plan !== 'pro' && 'Upgrade to Pro for 10× more credits per month.'}
                  <div className="mt-3 flex gap-2">
                    <Link to="/app/settings" className="btn-primary">
                      {profile?.plan === 'pro' ? 'View Usage' : 'Upgrade'}
                    </Link>
                  </div>
                </div>
              )}
              {error && (
                <div className="card p-4 font-mono text-xs text-accent border-accent">
                  {error}
                </div>
              )}
            </div>
            <form onSubmit={onSubmit} className="border-t border-border p-4 flex gap-3">
              <textarea
                className="input font-mono resize-none"
                rows={3}
                placeholder={
                  html
                    ? 'Tell it what to change — "make the header bigger", "fix the contact form", or describe a new site…'
                    : 'Paste business info — name, address, phone, hours, what they do…'
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(e);
                }}
                disabled={busy}
              />
              <button className="btn-primary self-end" disabled={busy || !input.trim()}>
                {busy ? '…' : 'Generate'}
              </button>
            </form>
          </section>

          <Divider
            onDrag={(dx) =>
              setGenW((w) => clamp(w + dx, 320, window.innerWidth - 480))
            }
          />

          <section className="flex flex-col min-h-0 flex-1 min-w-0">
            <div className="px-5 h-12 border-b border-border flex items-center justify-between">
              <div className="font-mono uppercase tracking-widest text-xs text-muted">preview</div>
              <div className="flex items-center gap-2">
                <button
                  className="btn"
                  disabled={!latestSite}
                  onClick={() => setSaleOpen(true)}
                >
                  Mark Sold
                </button>
                <button
                  className="btn"
                  disabled={!latestSite}
                  onClick={() => navigate(`/app/editor/${latestSite.id}`)}
                >
                  Customize
                </button>
                <button className="btn" disabled={!html} onClick={openFullscreen}>Fullscreen</button>
                <button
                  className="btn"
                  disabled={!html}
                  onClick={() => downloadHtml(businessForFile, html)}
                >
                  Download
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 bg-black">
              {previewUrl ? (
                <iframe
                  title="preview"
                  src={previewUrl}
                  className="w-full h-full bg-white"
                  // No allow-same-origin: preview runs in an opaque origin and cannot
                  // reach the parent window / localStorage / Supabase session token.
                  sandbox="allow-scripts allow-forms allow-popups allow-modals"
                />
              ) : (
                <div className="h-full flex items-center justify-center font-mono text-xs text-muted">
                  preview appears here after generation
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <SaleModal
        open={saleOpen}
        site={latestSite}
        onClose={() => setSaleOpen(false)}
        onSaved={(updated) => setLatestSite(updated)}
      />
    </div>
  );
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function Divider({ onDrag }) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    const move = (e) => onDrag(e.movementX);
    const up = () => setActive(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [active, onDrag]);
  return (
    <>
      <div
        onPointerDown={() => setActive(true)}
        className={`w-1 shrink-0 cursor-col-resize ${
          active ? 'bg-accent' : 'bg-border hover:bg-accent'
        }`}
      />
      {active && (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none" />
      )}
    </>
  );
}

function Message({ role, content }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] card p-3 font-mono text-sm whitespace-pre-wrap ${isUser ? 'border-accent' : ''}`}>
        <div className={`label mb-1 ${isUser ? 'text-accent' : ''}`}>{isUser ? 'you' : 'siteforge'}</div>
        <div>{content}</div>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="card p-3 inline-flex items-center gap-2 font-mono text-xs text-muted">
      <span>generating</span>
      <span className="inline-flex gap-1">
        <Dot delay={0} /><Dot delay={150} /><Dot delay={300} />
      </span>
    </div>
  );
}
function Dot({ delay }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 bg-accent"
      style={{ animation: 'pulse 1s ease-in-out infinite', animationDelay: `${delay}ms` }}
    />
  );
}

function EmptyState() {
  return (
    <div className="card p-6 font-mono text-sm text-muted">
      <div className="label mb-3">how to start</div>
      Paste a business description into the input below. Example:
      <div className="mt-3 p-3 border border-border bg-bg text-text whitespace-pre-wrap">
{`Create a website for this local coffee shop:
Blue Leaf Coffee, 123 Main St, known for specialty
lattes and cozy atmosphere, open Mon–Sat 7am–8pm,
phone 555-1234`}
      </div>
    </div>
  );
}
