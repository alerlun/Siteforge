import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../lib/auth.jsx';
import { callFunction } from '../lib/api.js';
import { formatCredits, estimateCredits } from '../lib/credits.js';
import { downloadHtml } from '../lib/utils.js';

// Script injected into the preview blob to enable element selection via postMessage.
// Runs in the iframe's isolated origin — no access to parent localStorage.
const SELECTION_SCRIPT = `
(function() {
  let editMode = false;
  let hovered = null;
  let selected = null;
  const HIGHLIGHT = '0 0 0 2px #f59e0b inset';
  const SELECT    = '0 0 0 3px #f59e0b inset';

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML' && cur.tagName !== 'BODY') {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { sel += '#' + cur.id; parts.unshift(sel); break; }
      const sib = Array.from(cur.parentNode ? cur.parentNode.children : []);
      const sameTag = sib.filter(s => s.tagName === cur.tagName);
      if (sameTag.length > 1) sel += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function isSelectable(el) {
    const tag = el.tagName.toLowerCase();
    return ['section','div','header','footer','main','article','aside','nav','figure','form'].includes(tag)
      || el.className.toString().includes('section')
      || el.className.toString().includes('hero')
      || el.className.toString().includes('block');
  }

  function nearestSelectable(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (isSelectable(cur)) return cur;
      cur = cur.parentElement;
    }
    return el.closest('section,div,header,footer,main,article') ?? el;
  }

  document.addEventListener('mouseover', function(e) {
    if (!editMode) return;
    const target = nearestSelectable(e.target);
    if (target === selected) return;
    if (hovered && hovered !== selected) hovered.style.boxShadow = '';
    hovered = target;
    target.style.boxShadow = HIGHLIGHT;
  }, true);

  document.addEventListener('mouseout', function(e) {
    if (!editMode || !hovered || hovered === selected) return;
    hovered.style.boxShadow = '';
    hovered = null;
  }, true);

  document.addEventListener('click', function(e) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    const target = nearestSelectable(e.target);
    if (selected && selected !== target) selected.style.boxShadow = '';
    selected = target;
    target.style.boxShadow = SELECT;
    window.parent.postMessage({
      type: 'ELEMENT_SELECTED',
      outerHtml: target.outerHTML,
      path: cssPath(target),
    }, '*');
  }, true);

  window.addEventListener('message', function(e) {
    if (e.data?.type === 'ENABLE_EDIT_MODE') {
      editMode = true;
      document.body.style.cursor = 'crosshair';
    } else if (e.data?.type === 'DISABLE_EDIT_MODE') {
      editMode = false;
      document.body.style.cursor = '';
      if (hovered) { hovered.style.boxShadow = ''; hovered = null; }
      if (selected) { selected.style.boxShadow = ''; selected = null; }
    }
  });
})();
`;

function injectSelectionScript(html) {
  const scriptTag = `<script>${SELECTION_SCRIPT}<\/script>`;
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose !== -1) return html.slice(0, bodyClose) + scriptTag + html.slice(bodyClose);
  return html + scriptTag;
}

const DEVICES = [
  { key: 'desktop', label: 'Desktop', width: '100%' },
  { key: 'tablet',  label: 'Tablet',  width: '768px' },
  { key: 'mobile',  label: 'Mobile',  width: '390px' },
];

export default function Editor() {
  const { siteId } = useParams();
  const navigate = useNavigate();
  const { user, profile, refreshProfile } = useAuth();
  const iframeRef = useRef(null);

  const [site, setSite] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [html, setHtml] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');

  // History for undo/redo. Each entry is a full HTML string.
  const [history, setHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  const [editMode, setEditMode] = useState(false);
  const [selectedEl, setSelectedEl] = useState(null); // { outerHtml, path }
  const [instruction, setInstruction] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  const [device, setDevice] = useState('desktop');
  const [showHistory, setShowHistory] = useState(false);

  const creditBalance = profile?.credit_balance ?? 0;
  const canEdit = creditBalance >= estimateCredits('elementEdit');

  // Load site on mount.
  useEffect(() => {
    if (!siteId || !user) return;
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from('generated_sites')
        .select('*')
        .eq('id', siteId)
        .eq('user_id', user.id)
        .single();
      if (!active) return;
      if (error || !data) { setLoadError('Site not found.'); return; }
      setSite(data);
      const initialHtml = data.html_output ?? '';
      setHtml(initialHtml);
      setHistory([initialHtml]);
      setHistoryIdx(0);
    })();
    return () => { active = false; };
  }, [siteId, user]);

  // Rebuild blob URL whenever html changes.
  useEffect(() => {
    if (!html) { setPreviewUrl(''); return; }
    const injected = injectSelectionScript(html);
    const url = URL.createObjectURL(new Blob([injected], { type: 'text/html;charset=utf-8' }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  // When preview reloads (new URL), re-signal edit mode if active.
  useEffect(() => {
    if (!previewUrl || !editMode) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => iframe.contentWindow?.postMessage({ type: 'ENABLE_EDIT_MODE' }, '*');
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [previewUrl, editMode]);

  // Listen for element selection from iframe.
  useEffect(() => {
    function onMessage(e) {
      if (e.data?.type === 'ELEMENT_SELECTED') {
        setSelectedEl({ outerHtml: e.data.outerHtml, path: e.data.path });
        setInstruction('');
        setApplyError('');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  function toggleEditMode() {
    const next = !editMode;
    setEditMode(next);
    setSelectedEl(null);
    iframeRef.current?.contentWindow?.postMessage(
      { type: next ? 'ENABLE_EDIT_MODE' : 'DISABLE_EDIT_MODE' },
      '*',
    );
  }

  // Push new HTML onto undo history.
  const pushHistory = useCallback((newHtml) => {
    setHistory((prev) => {
      const base = prev.slice(0, historyIdx + 1);
      return [...base, newHtml];
    });
    setHistoryIdx((i) => i + 1);
    setHtml(newHtml);
  }, [historyIdx]);

  function undo() {
    if (historyIdx <= 0) return;
    const idx = historyIdx - 1;
    setHistoryIdx(idx);
    setHtml(history[idx]);
  }

  function redo() {
    if (historyIdx >= history.length - 1) return;
    const idx = historyIdx + 1;
    setHistoryIdx(idx);
    setHtml(history[idx]);
  }

  function restoreVersion(idx) {
    setHistoryIdx(idx);
    setHtml(history[idx]);
    setShowHistory(false);
  }

  async function saveToDb(newHtml) {
    await supabase
      .from('generated_sites')
      .update({ html_output: newHtml })
      .eq('id', siteId);
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 2000);
  }

  async function applyEdit(e) {
    e.preventDefault();
    if (!selectedEl || !instruction.trim() || applying) return;
    if (!canEdit) { setApplyError('Insufficient credits.'); return; }
    setApplying(true);
    setApplyError('');
    try {
      const { updatedHtml } = await callFunction('edit-element', {
        siteId,
        elementHtml: selectedEl.outerHtml,
        instruction: instruction.trim(),
        elementPath: selectedEl.path,
      });

      // Splice updated element back into full HTML.
      // Primary: direct string replace. Fallback: CSS-path DOM replace (handles
      // browser-normalised outerHTML that won't match the original source string).
      let newHtml = html.replace(selectedEl.outerHtml, updatedHtml);
      if (newHtml === html && selectedEl.path) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const target = doc.querySelector(selectedEl.path);
        if (target) {
          target.outerHTML = updatedHtml;
          newHtml = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
        }
      }
      pushHistory(newHtml);
      await saveToDb(newHtml);
      await refreshProfile();

      // Clear selection after applying.
      setSelectedEl(null);
      setInstruction('');
      iframeRef.current?.contentWindow?.postMessage({ type: 'DISABLE_EDIT_MODE' }, '*');
      setEditMode(false);
    } catch (err) {
      setApplyError(err.message || 'Edit failed.');
    } finally {
      setApplying(false);
    }
  }

  const deviceCfg = DEVICES.find((d) => d.key === device);

  if (loadError) {
    return (
      <div className="h-screen flex flex-col items-center justify-center font-mono text-sm text-muted gap-4">
        <span>{loadError}</span>
        <button className="btn" onClick={() => navigate(-1)}>← Back</button>
      </div>
    );
  }

  if (!site) {
    return (
      <div className="h-screen flex items-center justify-center font-mono text-xs text-muted">
        loading editor…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg">
      {/* ── Navbar ── */}
      <nav className="h-12 border-b border-border px-4 flex items-center gap-3 shrink-0">
        <button className="btn text-xs" onClick={() => navigate(-1)}>← Back</button>

        <div className="h-4 w-px bg-border" />

        <button
          className="btn text-xs"
          disabled={historyIdx <= 0}
          onClick={undo}
          title="Undo"
        >
          ↩ Undo
        </button>
        <button
          className="btn text-xs"
          disabled={historyIdx >= history.length - 1}
          onClick={redo}
          title="Redo"
        >
          Redo ↪
        </button>
        <div className="relative">
          <button
            className={`btn text-xs ${showHistory ? 'border-accent text-accent' : ''}`}
            onClick={() => setShowHistory((v) => !v)}
          >
            History ({history.length})
          </button>
          {showHistory && (
            <div className="absolute left-0 top-full mt-1 z-50 w-56 card shadow-lg">
              {history.map((_, i) => (
                <button
                  key={i}
                  className={`w-full text-left px-3 py-2 font-mono text-xs hover:bg-surface ${i === historyIdx ? 'text-accent' : 'text-muted'}`}
                  onClick={() => restoreVersion(i)}
                >
                  {i === 0 ? 'Original' : `Edit ${i}`}
                  {i === historyIdx && ' ← current'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Device toggles */}
        {DEVICES.map((d) => (
          <button
            key={d.key}
            className={`btn text-xs ${device === d.key ? 'border-accent text-accent' : ''}`}
            onClick={() => setDevice(d.key)}
          >
            {d.label}
          </button>
        ))}

        <div className="h-4 w-px bg-border" />

        <button
          className={`btn text-xs ${editMode ? 'border-accent text-accent' : ''}`}
          onClick={toggleEditMode}
          title="Click any section to edit it with AI"
        >
          {editMode ? '[ Selecting... ]' : 'Customize'}
        </button>

        <div className="flex-1" />

        {savedMsg && (
          <span className="font-mono text-xs text-accent">{savedMsg}</span>
        )}

        <span
          className="font-mono text-xs text-muted"
          title="Remaining credits"
        >
          {formatCredits(creditBalance)} credits
        </span>

        <button
          className="btn text-xs"
          onClick={() => downloadHtml(site.business_name || 'site', html)}
        >
          Download
        </button>
      </nav>

      {/* ── Preview area ── */}
      <div className="flex-1 min-h-0 flex flex-col items-center bg-black overflow-hidden">
        {previewUrl ? (
          <div
            className="h-full transition-all duration-200"
            style={{ width: deviceCfg.width, maxWidth: '100%' }}
          >
            <iframe
              ref={iframeRef}
              title="editor-preview"
              src={previewUrl}
              className="w-full h-full bg-white"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center font-mono text-xs text-muted">
            loading preview…
          </div>
        )}
      </div>

      {/* ── Edit panel (slides up when element selected) ── */}
      {editMode && (
        <div className="border-t border-border bg-surface px-4 py-3 shrink-0">
          {!selectedEl ? (
            <p className="font-mono text-xs text-muted">
              Click any section in the preview to select it, then describe your change here.
            </p>
          ) : (
            <form onSubmit={applyEdit} className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="label text-[10px] mb-1 truncate">
                  Selected: <code className="text-accent">{selectedEl.path}</code>
                </div>
                <textarea
                  className="input font-mono text-sm resize-none w-full"
                  rows={2}
                  placeholder='e.g. "make the heading larger and change it to navy blue"'
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  autoFocus
                  disabled={applying}
                />
                {applyError && (
                  <div className="font-mono text-xs text-accent mt-1">{applyError}</div>
                )}
              </div>
              <div className="flex flex-col gap-2 shrink-0 pt-4">
                <button
                  type="submit"
                  className="btn-primary text-xs"
                  disabled={applying || !instruction.trim() || !canEdit}
                >
                  {applying ? 'Applying…' : 'Apply'}
                </button>
                <button
                  type="button"
                  className="btn text-xs"
                  onClick={() => { setSelectedEl(null); setInstruction(''); }}
                  disabled={applying}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
