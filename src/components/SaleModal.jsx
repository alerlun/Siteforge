import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';

export default function SaleModal({ open, site, onClose, onSaved }) {
  const [price, setPrice] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [status, setStatus] = useState('sold');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (open && site) {
      setPrice(site.sale_price ? String(site.sale_price) : '');
      setBusinessType(site.business_type ?? '');
      setBusinessName(site.business_name ?? '');
      setStatus(site.status ?? 'sold');
      setErr('');
    }
  }, [open, site]);

  if (!open || !site) return null;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const numericPrice = price === '' ? null : Number(price);
    if (numericPrice !== null && Number.isNaN(numericPrice)) {
      setErr('Price must be a number.');
      setBusy(false);
      return;
    }
    const { data, error } = await supabase
      .from('generated_sites')
      .update({
        sale_price: numericPrice,
        business_type: businessType || null,
        business_name: businessName || null,
        status,
      })
      .eq('id', site.id)
      .select()
      .single();
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onSaved?.(data);
    onClose?.();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="card border-border w-full max-w-md p-6 bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="label">log sale</div>
            <div className="font-mono text-lg mt-1">{site.business_name || 'Untitled site'}</div>
          </div>
          <button className="font-mono text-muted hover:text-text" onClick={onClose}>×</button>
        </div>
        <form onSubmit={save} className="space-y-3">
          <div>
            <div className="label mb-1">Business Name</div>
            <input className="input" value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Blue Leaf Coffee" />
          </div>
          <div>
            <div className="label mb-1">Business Type</div>
            <input className="input" value={businessType} onChange={(e) => setBusinessType(e.target.value)} placeholder="coffee shop" />
          </div>
          <div>
            <div className="label mb-1">Sale Price (USD)</div>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="500"
            />
          </div>
          <div>
            <div className="label mb-1">Status</div>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="sold">sold</option>
              <option value="pending">pending</option>
              <option value="cancelled">cancelled</option>
            </select>
          </div>
          {err && <div className="font-mono text-xs text-accent">{err}</div>}
          <div className="flex gap-2 pt-2">
            <button type="button" className="btn flex-1" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={busy}>{busy ? 'saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
