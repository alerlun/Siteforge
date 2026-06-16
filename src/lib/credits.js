// Client-side credit config — mirrors the DB config table values.
// Update here when you change the DB config rows.
export const CREDIT_RATES = {
  inRate:  1,
  outRate: 5,
  margin:  1.1,
};

export const MONTHLY_ALLOWANCE = {
  free: 68_000,
  pro:  680_000,
};

// Conservative pre-flight estimates (input_tokens, output_tokens).
const ESTIMATES = {
  generation: { input: 1200, output: 8000 },
  edit:       { input: 15000, output: 12000 },
  elementEdit:{ input: 500,  output: 3000 },
};

export function estimateCredits(type = 'generation') {
  const e = ESTIMATES[type] ?? ESTIMATES.generation;
  return Math.ceil((e.input * CREDIT_RATES.inRate + e.output * CREDIT_RATES.outRate) * CREDIT_RATES.margin);
}

export function formatCredits(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
