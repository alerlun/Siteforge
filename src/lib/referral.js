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
  } finally {
    clearPendingReferral();
  }
}

export async function getReferralStats() {
  return callFunction('referral-stats', {});
}
