import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';
import { callFunction, planLimit } from '../lib/api.js';
import { downloadHtml } from '../lib/utils.js';
import SaleModal from '../components/SaleModal.jsx';
import SessionsPanel from '../components/SessionsPanel.jsx';

export default function Chat() {
  const { user, profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const initialPrompt = location.state?.prompt ?? '';
  const initialMeta = location.state?.meta ?? null;

  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(initialPrompt);
  const [meta, setMeta] = useState(initialMeta);
  const [html, setHtml] = useState('');
  const [latestSite, setLatestSite] = useState(null);
  const [busy, setBusy] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const [error, setError] = useState('');
  const [saleOpen, setSaleOpen] = useState(false);
  const threadRef = useRef(null);

  const limit = planLimit(profile, 'generations');
  const used = profile?.generations_used ?? 0;
  const remaining = Math.max(0, limit - used);
  const planLabel = profile?.plan === 'pro' ? '[PRO]' : '[FREE]';

  // Load sessions on mount.
  const loadSessions = useCallback(async () => {
    if (!user?.id) return;
    setSessionsLoading(true);
    const { data, error: err } = await supabase
      .from('chat_sessions')
      .select('id, title, created_at, updated_at')
      .order('updated_at', { ascending: false });
    setSessionsLoading(false);
    if (err) {
      console.error(err);
      return;
    }
    setSessions(data ?? []);
  }, [user?.id]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Open the most recent session by default; if none, leave activeSessionId null
  // so the next generate creates one.
  useEffect(() => {
    if (sessionsLoading) return;
    if (activeSessionId) return;
    if (sessions.length === 0) return;
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
    if (remaining <= 0) {
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
      });

      const newSessionId = data.sessionId;
      const site = data.site;
      const reviewedNote = data.reviewed ? ' (reviewed)' : '';
      const assistantContent = site?.business_name
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
      if (err.status === 402 || err.message === 'limit_reached') {
        setLimitHit(true);
      } else {
        setError(err.message || 'Generation failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  const businessForFile = latestSite?.business_name || meta?.businessName || 'site';

  function openFullscreen() {
    if (!html) return;
    const w = window.open('', '_blank');
    if (w) {
      w.document.open();
      w.document.write(html);
      w.document.close();
    }
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
      />
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
            >
              Generations: {used}/{limit}
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: '60fr 40fr' }}>
          <section className="flex flex-col min-h-0 border-r border-border">
            <div ref={threadRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
              {messages.length === 0 && !busy && <EmptyState />}
              {messages.map((m, i) => (
                <Message key={i} role={m.role} content={m.content} />
              ))}
              {busy && <TypingIndicator />}
              {limitHit && (
                <div className="card border-accent p-4 font-mono text-sm">
                  Generation limit reached. Upgrade to Pro for 10/month.
                  <div className="mt-3">
                    <Link to="/app/settings" className="btn-primary">Upgrade</Link>
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
                placeholder="Paste business info — name, address, phone, hours, what they do…"
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

          <section className="flex flex-col min-h-0">
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
              {html ? (
                <iframe
                  title="preview"
                  srcDoc={html}
                  className="w-full h-full bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms"
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
