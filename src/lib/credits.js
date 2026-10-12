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

// Pre-flight estimates — must match what the server reserves before the AI call
// (estimateCredits in supabase/functions/generate-site/index.ts and the estimate in
// edit-element/index.ts), otherwise the button enables and the server answers 402.
// Estimates follow the size of what is sent:
// - generation: base prompt + chat history (~3 characters per token), a prompt-cache
//   write (charged at 2x the input rate) and 10k output tokens;
// - edit (chat): the whole site (~2.5 HTML characters per token) + prompt, 3k output;
// - elementEdit: the selected element (~2.5 characters per token) + the full 4096-token
//   output budget.
const HTML_CHARS_PER_TOKEN = 2.5;
const TEXT_CHARS_PER_TOKEN = 3;
const BUILD_BASE_INPUT_TOKENS = 1200;
const EDIT_PROMPT_OVERHEAD_TOKENS = 1500;
const EDIT_OUTPUT_ESTIMATE = 3000;
const ELEMENT_BASE_INPUT_TOKENS = 300;
const ELEMENT_MAX_OUTPUT_TOKENS = 4096;

// chars = history characters (generation), site characters (edit) or element +
// instruction characters (elementEdit).
export function estimateCredits(type = 'generation', chars = 0) {
  let e;
  if (type === 'edit') {
    e = { input: Math.ceil(chars / HTML_CHARS_PER_TOKEN) + EDIT_PROMPT_OVERHEAD_TOKENS, cacheWrite: 0, output: EDIT_OUTPUT_ESTIMATE };
  } else if (type === 'elementEdit') {
    e = { input: ELEMENT_BASE_INPUT_TOKENS + Math.ceil(chars / HTML_CHARS_PER_TOKEN), cacheWrite: 0, output: ELEMENT_MAX_OUTPUT_TOKENS };
  } else {
    e = { input: BUILD_BASE_INPUT_TOKENS + Math.ceil(chars / TEXT_CHARS_PER_TOKEN), cacheWrite: 2000, output: 10000 };
  }
  const inRate = CREDIT_RATES.inRate;
  return Math.ceil(
    (e.input * inRate + e.cacheWrite * inRate * 2 + e.output * CREDIT_RATES.outRate) * CREDIT_RATES.margin,
  );
}

// Exact balance, e.g. "476,661". Rounding (the old "477k") hid small deductions.
export function formatCredits(n) {
  if (n == null) return '—';
  return Math.round(Number(n)).toLocaleString('en-US');
}

// Compact form for tight spaces only (mobile header), e.g. "476.7k".
export function formatCreditsShort(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

// Signed change for the credit history, e.g. "−69,821" / "+612,000" / "0".
export function formatCreditDelta(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n));
  if (v === 0) return '0';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US')}`;
}

// Human-readable labels for credit_ledger.action_type.
export const LEDGER_LABELS = {
  generation:        'New site',
  edit:              'Chat edit',
  element_edit:      'Element edit',
  classify:          'Classify',
  monthly_reset:     'Monthly reset',
  renewal:           'Pro renewal',
  plan_upgrade:      'Upgrade to Pro',
  referral_bonus:    'Referral bonus',
  manual_correction: 'Adjustment',
};
