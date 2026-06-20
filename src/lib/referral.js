import { callFunction } from './api.js';

const PENDING_KEY = 'sf_pending_referral';

export function storePendingReferral(code) {
  if (code) localStorage.setItem(PENDING_KEY, code.trim().toUpperCase());
}

export function getPendingReferral() {
  return localStorage.getItem(PENDING_KEY);
}

export function clearPendingReferral() {
  localStorage.removeItem(PENDING_KEY);
}

export async function claimReferral(code) {
  try {
    await callFunction('claim-referral', { referral_code: code });
    // Success — clear the stored code.
    clearPendingReferral();
  } catch (err) {
    // Clear on permanent rejections (already attributed, self-referral, expired window).
    // Preserve key on transient errors so the next page load can retry.
    const permanent = ['already_attributed', 'self_referral', 'claim_window_expired', 'invalid_code'];
    const code_str = err?.code ?? err?.message ?? '';
    if (permanent.some((p) => code_str.includes(p))) {
      clearPendingReferral();
    }
    // Don't rethrow — claim errors are non-fatal; fire-and-forget callers don't handle them.
  }
}

export async function getReferralStats() {
  return callFunction('referral-stats', {});
}
