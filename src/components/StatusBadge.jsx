const STYLES = {
  new: 'border-border text-text',
  contacted: 'border-border text-muted',
  sold: 'border-accent text-accent',
  not_interested: 'border-border text-muted',
  pending: 'border-border text-muted',
  cancelled: 'border-border text-muted',
  pro: 'border-accent text-accent',
  free: 'border-border text-text',
  has_website: 'border-border text-muted',
  no_website: 'border-accent text-accent',
};

export default function StatusBadge({ value }) {
  const key = String(value ?? '').toLowerCase();
  const cls = STYLES[key] ?? 'border-border text-text';
  const label = key.replace(/_/g, ' ').toUpperCase();
  return <span className={`badge ${cls}`}>[{label}]</span>;
}
