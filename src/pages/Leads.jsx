import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import { supabase } from '../lib/supabase.js';
import { useAuth, isProUser } from '../lib/auth.jsx';
import { callFunction, planLimit, PLAN_LIMITS } from '../lib/api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatDate } from '../lib/utils.js';

function DetailField({ label, children }) {
  return (
    <div>
      <div className="label text-[9px] mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}

const RADIUS_OPTIONS = ['1mi', '5mi', '10mi', '25mi'];
const RESULT_OPTIONS = [20, 50, 100];
const STATUS_OPTIONS = ['new', 'contacted', 'sold', 'not_interested'];

export default function Leads() {
  const { profile, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const [businessType, setBusinessType] = useState('');
  const [city, setCity] = useState('');
  const [radius, setRadius] = useState('5mi');
  const [maxResults, setMaxResults] = useState(20);
  const [websiteFilter, setWebsiteFilter] = useState('without');
  const [rows, setRows] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [limitHit, setLimitHit] = useState(false);
  const [info, setInfo] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);

  const isPro = isProUser(profile);
  const limit = planLimit(profile, 'leads');
  const used = profile?.leads_used ?? 0;

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false });
      if (!active) return;
      if (!err) setRows(data ?? []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  async function onSearch(e) {
    e.preventDefault();
    if (!businessType.trim() || !city.trim()) return;
    setError('');
    setInfo('');
    setLimitHit(false);
    setSearching(true);
    try {
      const data = await callFunction('scrape-leads', {
        businessType: businessType.trim(),
        city: city.trim(),
        radius,
        maxResults,
        websiteFilter,
      });
      setRows((prev) => [...(data.leads ?? []), ...prev]);
      const examined = data.examined ?? 0;
      const skipped = data.skippedHasWebsite ?? 0;
      const found = data.count ?? 0;
      const quotaUsed = data.quotaUsed ?? found;
      // Every 5 businesses scanned use at least 1 lead of the quota (server: EXAMINED_PER_LEAD).
      const quotaNote = quotaUsed > found ? ` Used ${quotaUsed} of your lead quota (1 per 5 scanned).` : '';
      // Businesses already in the user's leads are skipped without using quota.
      const known = data.skippedKnown ?? 0;
      const knownNote = known ? ` ${known} already in your leads were skipped.` : '';
      if (examined === 0 && known > 0) {
        setInfo(`All ${known} businesses found are already in your leads. Try a different city or business type.`);
      } else if (websiteFilter === 'both') {
        setInfo(
          (found === 0
            ? `Scanned ${examined} businesses — no results. Try a different city or business type.`
            : `Scanned ${examined} — added ${found} businesses (with + without websites).`) + knownNote + quotaNote,
        );
      } else {
        setInfo(
          (found === 0
            ? `Scanned ${examined} businesses — all have websites. Try a different city or business type.`
            : `Scanned ${examined} — kept ${found} without websites, skipped ${skipped} with websites.`) + knownNote + quotaNote,
        );
      }
      await refreshProfile();
    } catch (err) {
      if (err.status === 402) setLimitHit(true);
      else if (err.data?.error === 'places_api_error') {
        const d = err.data.detail ?? {};
        setError(`Google Places error (${d.status ?? 'unknown'})${d.message ? `: ${d.message}` : ''}`);
      } else setError(err.message || 'Search failed.');
    } finally {
      setSearching(false);
    }
  }

  async function updateStatus(id, status) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
    await supabase.from('leads').update({ status }).eq('id', id);
  }

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Leads hold third-party business data (often a sole trader's name and phone), so the
  // user must be able to remove them (AUDIT-APP.md M11). Chats keep working: lead_id is
  // set null. A deleted place can be found again by a later search.
  async function deleteLeads(ids) {
    if (!ids.length || deleting) return;
    const label = ids.length === 1 ? 'this lead' : `${ids.length} leads`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    setDeleting(true);
    setError('');
    const { error: err } = await supabase.from('leads').delete().in('id', ids);
    setDeleting(false);
    if (err) {
      setError(`Could not delete: ${err.message}`);
      return;
    }
    const gone = new Set(ids);
    setRows((prev) => prev.filter((r) => !gone.has(r.id)));
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    if (gone.has(expandedId)) setExpandedId(null);
  }

  function generateForLead(lead) {
    const parts = [
      `Create a website for this local business: ${lead.business_name ?? ''}`,
      lead.address ? `Address: ${lead.address}` : '',
      lead.phone ? `Phone: ${lead.phone}` : '',
      lead.rating ? `Rating: ${lead.rating} (${lead.review_count ?? 0} reviews)` : '',
    ].filter(Boolean).join('. ');
    navigate('/app/chat', {
      state: {
        prompt: parts,
        leadId: lead.id,
        meta: {
          businessName: lead.business_name,
          clientLocation: lead.address,
        },
      },
    });
  }

  function exportCsv() {
    if (!isPro) return;
    const csv = Papa.unparse(
      rows.map((r) => ({
        business_name: r.business_name,
        phone: r.phone ?? '',
        address: r.address ?? '',
        rating: r.rating ?? '',
        review_count: r.review_count ?? '',
        has_website: r.has_website ? 'yes' : 'no',
        website_url: r.website_url ?? '',
        status: r.status ?? '',
      })),
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `siteforge-leads-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b border-border h-14 px-5 flex items-center justify-between shrink-0 gap-3">
        <div className="font-mono uppercase tracking-widest text-xs text-muted shrink-0">leads</div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span className="badge border-border text-text whitespace-nowrap">Leads used: {used}/{limit}</span>
          {selected.size > 0 && (
            <button className="btn text-xs px-2 py-1" disabled={deleting} onClick={() => deleteLeads([...selected])}>
              {deleting ? 'deleting…' : `Delete ${selected.size}`}
            </button>
          )}
          {isPro && (
            <button className="btn text-xs px-2 py-1" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
          )}
        </div>
      </header>

      <div className="px-5 py-4 border-b border-border">
        <form onSubmit={onSearch} className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <div className="label mb-1">Business Type</div>
            <input className="input" placeholder="plumber" value={businessType} onChange={(e) => setBusinessType(e.target.value)} />
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <div className="label mb-1">City</div>
            <input className="input" placeholder="Austin, TX" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="w-[calc(50%-6px)] sm:w-auto sm:min-w-[120px]">
            <div className="label mb-1">Radius</div>
            <select className="input" value={radius} onChange={(e) => setRadius(e.target.value)}>
              {RADIUS_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="w-[calc(50%-6px)] sm:w-auto sm:min-w-[140px]">
            <div className="label mb-1">Max Results</div>
            <select className="input" value={maxResults} onChange={(e) => setMaxResults(parseInt(e.target.value, 10))}>
              {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[200px]">
            <div className="label mb-1">Website Filter</div>
            <select className="input" value={websiteFilter} onChange={(e) => setWebsiteFilter(e.target.value)}>
              <option value="without">Without website only</option>
              <option value="both">With + without websites</option>
            </select>
          </div>
          <button className="btn-primary w-full sm:w-auto" disabled={searching}>
            {searching ? 'searching…' : 'Search Leads'}
          </button>
        </form>
        {limitHit && (
          <div className="mt-3 card border-accent p-3 font-mono text-xs">
            Lead limit reached.{' '}
            {isPro
              ? 'Your limit resets on the 1st of next month.'
              : `Upgrade to Pro for ${PLAN_LIMITS.pro.leads}/month.`}
          </div>
        )}
        {info && <div className="mt-3 font-mono text-xs text-muted">{info}</div>}
        {error && <div className="mt-3 font-mono text-xs text-accent">{error}</div>}
      </div>

      <div className="flex-1 overflow-auto pb-14 md:pb-0">
        {loading ? (
          <div className="p-6 font-mono text-xs text-muted">loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 font-mono text-xs text-muted">no leads yet — run a search above.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="data">
            <thead className="sticky top-0 bg-surface z-10">
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all leads"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th>Business Name</th>
                <th>Type</th>
                <th>Phone</th>
                <th>Address</th>
                <th>Rating</th>
                <th>Website</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isExpanded = expandedId === r.id;
                return [
                  <tr
                    key={r.id}
                    className="cursor-pointer hover:bg-surface/50"
                    onClick={() => setExpandedId(isExpanded ? null : r.id)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.business_name}`}
                        checked={selected.has(r.id)}
                        onChange={() => toggleSelected(r.id)}
                      />
                    </td>
                    <td className="font-mono">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-muted text-[10px]">{isExpanded ? '▼' : '▶'}</span>
                        {r.business_name}
                      </span>
                    </td>
                    <td className="text-muted">{r.business_type || '—'}</td>
                    <td className="font-mono">{r.phone || <span className="text-muted">—</span>}</td>
                    <td>{r.address || <span className="text-muted">—</span>}</td>
                    <td className="font-mono">{r.rating ? `${r.rating} (${r.review_count ?? 0})` : <span className="text-muted">—</span>}</td>
                    <td>
                      {r.has_website ? (
                        <a href={r.website_url || '#'} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          <StatusBadge value="has_website" />
                        </a>
                      ) : (
                        <StatusBadge value="no_website" />
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className="input py-1"
                        value={r.status ?? 'new'}
                        onChange={(e) => updateStatus(r.id, e.target.value)}
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="btn" onClick={() => generateForLead(r)}>Generate Site</button>
                    </td>
                  </tr>,
                  isExpanded && (
                    <tr key={`${r.id}-detail`} className="bg-surface/30">
                      <td colSpan={9} className="px-6 py-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 font-mono text-xs">
                          <DetailField label="EMAIL">
                            {r.email
                              ? <a href={`mailto:${r.email}`} className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>{r.email}</a>
                              : <span className="text-muted">—</span>}
                          </DetailField>
                          <DetailField label="WEBSITE URL">
                            {r.website_url
                              ? <a href={r.website_url} target="_blank" rel="noreferrer" className="text-accent hover:underline truncate block max-w-[200px]" onClick={(e) => e.stopPropagation()}>{r.website_url}</a>
                              : <span className="text-muted">none</span>}
                          </DetailField>
                          <DetailField label="DATE CAPTURED">
                            {formatDate(r.created_at)}
                          </DetailField>
                          <DetailField label="LEAD ID">
                            <span className="text-muted text-[10px] break-all">{r.id}</span>
                          </DetailField>
                          <DetailField label="REVIEWS">
                            {r.review_count != null ? `${r.review_count} reviews` : <span className="text-muted">—</span>}
                          </DetailField>
                          <DetailField label="RATING">
                            {r.rating != null ? `${r.rating} / 5` : <span className="text-muted">—</span>}
                          </DetailField>
                          <DetailField label="STATUS">
                            <select
                              className="input py-1 text-xs"
                              value={r.status ?? 'new'}
                              onChange={(e) => { e.stopPropagation(); updateStatus(r.id, e.target.value); }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {STATUS_OPTIONS.map((s) => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                          </DetailField>
                          <DetailField label="ACTION">
                            <button
                              className="btn-primary text-xs py-1 px-3"
                              onClick={(e) => { e.stopPropagation(); generateForLead(r); }}
                            >
                              Generate Site →
                            </button>
                            <button
                              className="btn text-xs py-1 px-3 ml-2"
                              disabled={deleting}
                              onClick={(e) => { e.stopPropagation(); deleteLeads([r.id]); }}
                            >
                              Delete
                            </button>
                          </DetailField>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
