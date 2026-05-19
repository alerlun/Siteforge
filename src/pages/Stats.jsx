import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { supabase } from '../lib/supabase.js';
import { formatCurrency, formatDate } from '../lib/utils.js';
import StatusBadge from '../components/StatusBadge.jsx';
import SaleModal from '../components/SaleModal.jsx';

export default function Stats() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from('generated_sites')
        .select('id, business_name, business_type, client_location, sale_price, status, created_at')
        .order('created_at', { ascending: false });
      if (!active) return;
      setSites(data ?? []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const metrics = useMemo(() => {
    const total = sites.length;
    const sold = sites.filter((s) => s.status === 'sold').length;
    const revenue = sites.filter((s) => s.status === 'sold').reduce((sum, s) => sum + Number(s.sale_price ?? 0), 0);
    const conversion = total ? (sold / total) * 100 : 0;
    return { total, sold, revenue, conversion };
  }, [sites]);

  const monthlyGenerated = useMemo(() => buildLast6Months(sites, 'count'), [sites]);
  const monthlyRevenue = useMemo(() => buildLast6Months(sites, 'revenue'), [sites]);

  function applyUpdate(updated) {
    setSites((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
  }

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b border-border h-14 px-5 flex items-center justify-between shrink-0">
        <div className="font-mono uppercase tracking-widest text-xs text-muted">statistics</div>
      </header>

      <div className="flex-1 overflow-auto px-5 py-5 space-y-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric label="TOTAL SITES GENERATED" value={metrics.total} />
          <Metric label="TOTAL SITES SOLD" value={metrics.sold} />
          <Metric label="TOTAL REVENUE" value={formatCurrency(metrics.revenue)} />
          <Metric label="CONVERSION RATE" value={`${metrics.conversion.toFixed(1)}%`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Chart title="SITES GENERATED / MONTH (LAST 6)">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={monthlyGenerated}>
                <CartesianGrid stroke="#1e1e1e" vertical={false} />
                <XAxis dataKey="label" stroke="#6b6b6b" tick={{ fontFamily: 'DM Mono', fontSize: 11 }} />
                <YAxis stroke="#6b6b6b" tick={{ fontFamily: 'DM Mono', fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#1a1a1a' }} />
                <Bar dataKey="value" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </Chart>
          <Chart title="REVENUE OVER TIME">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={monthlyRevenue}>
                <CartesianGrid stroke="#1e1e1e" vertical={false} />
                <XAxis dataKey="label" stroke="#6b6b6b" tick={{ fontFamily: 'DM Mono', fontSize: 11 }} />
                <YAxis stroke="#6b6b6b" tick={{ fontFamily: 'DM Mono', fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatCurrency(v)} />
                <Line type="monotone" dataKey="value" stroke="#f59e0b" strokeWidth={2} dot={{ fill: '#f59e0b' }} />
              </LineChart>
            </ResponsiveContainer>
          </Chart>
        </div>

        <div className="card">
          <div className="px-4 py-3 border-b border-border label flex items-center justify-between">
            <span>recent sales</span>
            <span className="text-[10px] text-muted">click "Edit" on any row to log price + type</span>
          </div>
          {loading ? (
            <div className="p-4 font-mono text-xs text-muted">loading…</div>
          ) : sites.length === 0 ? (
            <div className="p-4 font-mono text-xs text-muted">no sites generated yet.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Business Name</th>
                  <th>Type</th>
                  <th>Location</th>
                  <th>Sale Price</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id}>
                    <td className="font-mono">{s.business_name || '—'}</td>
                    <td className="text-muted">{s.business_type || '—'}</td>
                    <td>{s.client_location || <span className="text-muted">—</span>}</td>
                    <td className="font-mono">{s.sale_price ? formatCurrency(s.sale_price) : <span className="text-muted">—</span>}</td>
                    <td className="font-mono text-muted">{formatDate(s.created_at)}</td>
                    <td><StatusBadge value={s.status ?? 'pending'} /></td>
                    <td>
                      <button className="btn text-[11px] py-1 px-2" onClick={() => setEditing(s)}>
                        {s.status === 'sold' ? 'Edit' : 'Mark Sold'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <SaleModal
        open={!!editing}
        site={editing}
        onClose={() => setEditing(null)}
        onSaved={applyUpdate}
      />
    </div>
  );
}

const tooltipStyle = {
  background: '#111111',
  border: '1px solid #1e1e1e',
  borderRadius: 2,
  fontFamily: 'DM Mono',
  fontSize: 12,
  color: '#e5e5e5',
};

function Metric({ label, value }) {
  return (
    <div className="card p-4">
      <div className="label">{label}</div>
      <div className="mt-2 font-mono text-2xl">{value}</div>
    </div>
  );
}

function Chart({ title, children }) {
  return (
    <div className="card p-4">
      <div className="label mb-3">{title}</div>
      {children}
    </div>
  );
}

function buildLast6Months(sites, kind) {
  const now = new Date();
  const buckets = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'short' }),
      value: 0,
    });
  }
  const idx = new Map(buckets.map((b, i) => [b.key, i]));
  for (const s of sites) {
    const d = new Date(s.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const i = idx.get(key);
    if (i === undefined) continue;
    if (kind === 'count') buckets[i].value += 1;
    else if (kind === 'revenue' && s.status === 'sold') buckets[i].value += Number(s.sale_price ?? 0);
  }
  return buckets;
}
