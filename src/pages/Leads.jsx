import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../lib/auth.jsx';
import { callFunction, planLimit } from '../lib/api.js';
import StatusBadge from '../components/StatusBadge.jsx';

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
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [limitHit, setLimitHit] = useState(false);
  const [info, setInfo] = useState('');

  const isPro = profile?.plan === 'pro';
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
      if (websiteFilter === 'both') {
        setInfo(
          found === 0
            ? `Scanned ${examined} businesses — no results. Try a different city or business type.`
            : `Scanned ${examined} — added ${found} businesses (with + without websites).`,
        );
      } else {
        setInfo(
          found === 0
            ? `Scanned ${examined} businesses — all have websites. Try a different city or business type.`
            : `Scanned ${examined} — kept ${found} without websites, skipped ${skipped} with websites.`,
        );
      }
      await refreshProfile();
    } catch (err) {
      if (err.status === 402) setLimitHit(true);
      else setError(err.message || 'Search failed.');
    } finally {
      setSearching(false);
    }
  }

  async function updateStatus(id, status) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
    await supabase.from('leads').update({ status }).eq('id', id);
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
      <header className="border-b border-border h-14 px-5 flex items-center justify-between shrink-0">
        <div className="font-mono uppercase tracking-widest text-xs text-muted">leads</div>
        <div className="flex items-center gap-3">
          <span className="badge border-border text-text">Leads used: {used}/{limit}</span>
          {isPro && (
            <button className="btn" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
          )}
        </div>
      </header>

      <div className="px-5 py-4 border-b border-border">
        <form onSubmit={onSearch} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px]">
            <div className="label mb-1">Business Type</div>
            <input className="input" placeholder="plumber" value={businessType} onChange={(e) => setBusinessType(e.target.value)} />
          </div>
          <div className="min-w-[180px]">
            <div className="label mb-1">City</div>
            <input className="input" placeholder="Austin, TX" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="min-w-[120px]">
            <div className="label mb-1">Radius</div>
            <select className="input" value={radius} onChange={(e) => setRadius(e.target.value)}>
              {RADIUS_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="min-w-[140px]">
            <div className="label mb-1">Max Results</div>
            <select className="input" value={maxResults} onChange={(e) => setMaxResults(parseInt(e.target.value, 10))}>
              {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="min-w-[200px]">
            <div className="label mb-1">Website Filter</div>
            <select className="input" value={websiteFilter} onChange={(e) => setWebsiteFilter(e.target.value)}>
              <option value="without">Without website only</option>
              <option value="both">With + without websites</option>
            </select>
          </div>
          <button className="btn-primary" disabled={searching}>
            {searching ? 'searching…' : 'Search Leads'}
          </button>
        </form>
        {limitHit && (
          <div className="mt-3 card border-accent p-3 font-mono text-xs">
            Lead limit reached. Upgrade to Pro for 1,000/month.
          </div>
        )}
        {info && <div className="mt-3 font-mono text-xs text-muted">{info}</div>}
        {error && <div className="mt-3 font-mono text-xs text-accent">{error}</div>}
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-6 font-mono text-xs text-muted">loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 font-mono text-xs text-muted">no leads yet — run a search above.</div>
        ) : (
          <table className="data">
            <thead className="sticky top-0 bg-surface z-10">
              <tr>
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
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono">{r.business_name}</td>
                  <td className="text-muted">{r.business_type || '—'}</td>
                  <td className="font-mono">{r.phone || <span className="text-muted">—</span>}</td>
                  <td>{r.address || <span className="text-muted">—</span>}</td>
                  <td className="font-mono">{r.rating ? `${r.rating} (${r.review_count ?? 0})` : <span className="text-muted">—</span>}</td>
                  <td>
                    {r.has_website ? (
                      <a href={r.website_url || '#'} target="_blank" rel="noreferrer">
                        <StatusBadge value="has_website" />
                      </a>
                    ) : (
                      <StatusBadge value="no_website" />
                    )}
                  </td>
                  <td>
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
                  <td>
                    <button className="btn" onClick={() => generateForLead(r)}>Generate Site</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
