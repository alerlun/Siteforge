export default function SessionsPanel({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  loading,
  width,
}) {
  return (
    <aside
      className="shrink-0 bg-surface flex flex-col"
      style={{ width }}
    >
      <div className="px-3 py-3 border-b border-border">
        <button onClick={onNew} className="btn-primary w-full text-xs">+ New chat</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="px-3 py-3 font-mono text-[11px] text-muted">loading…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-3 py-3 font-mono text-[11px] text-muted">no chats yet</div>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              className={`group flex items-start justify-between gap-2 px-3 py-2 border-l-2 cursor-pointer ${
                active ? 'border-accent bg-bg' : 'border-transparent hover:bg-bg/50'
              }`}
              onClick={() => onSelect(s.id)}
            >
              <div className="min-w-0 flex-1">
                <div className={`font-mono text-xs truncate ${active ? 'text-accent' : 'text-text'}`}>
                  {s.title || 'New chat'}
                </div>
                <div className="font-mono text-[10px] text-muted mt-0.5">
                  {formatTime(s.updated_at ?? s.created_at)}
                </div>
              </div>
              <button
                className="font-mono text-muted hover:text-accent opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
                title="Delete chat"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
