// Google Analytics 4 with Consent Mode v2 (default-deny).
//
// Loaded entirely from JS (no inline <script> in index.html) so the app's CSP can keep
// `script-src 'self' https://www.googletagmanager.com` without `'unsafe-inline'`. gtag.js
// is injected as an external script; the dataLayer pushes below run as same-origin module
// code, which CSP allows.
//
// Consent starts DENIED. Nothing that sets analytics cookies runs until grantConsent()
// is called (the consent banner does this on Accept). Page views are sent manually on
// route changes (send_page_view:false) because this is a client-side-routed SPA.

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const CONSENT_KEY = 'sf_ga_consent'; // 'granted' | 'denied'

let initialized = false;

function gtag() {
  // gtag must push the literal `arguments` object — do not spread.
  window.dataLayer.push(arguments);
}

export function storedConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

// Inject gtag.js and prime Consent Mode. Safe to call once; later calls no-op.
export function initAnalytics() {
  if (initialized || !GA_ID || typeof window === 'undefined') return;
  initialized = true;

  window.dataLayer = window.dataLayer || [];
  gtag('js', new Date());

  // Consent Mode v2 defaults — everything denied until the user opts in.
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });

  // Manual page_view (SPA): we fire them on route change via trackPageView().
  gtag('config', GA_ID, { send_page_view: false });

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);

  // Re-apply a previously granted consent so returning visitors aren't re-prompted.
  if (storedConsent() === 'granted') grantConsent({ persist: false });
}

export function grantConsent({ persist = true } = {}) {
  if (!GA_ID) return;
  if (persist) {
    try { localStorage.setItem(CONSENT_KEY, 'granted'); } catch { /* ignore */ }
  }
  gtag('consent', 'update', {
    ad_storage: 'granted',
    ad_user_data: 'granted',
    ad_personalization: 'granted',
    analytics_storage: 'granted',
  });
}

export function denyConsent() {
  try { localStorage.setItem(CONSENT_KEY, 'denied'); } catch { /* ignore */ }
  if (!GA_ID) return;
  gtag('consent', 'update', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
}

// Send a SPA page view. No-ops until init + consent allow it to actually record.
export function trackPageView(path) {
  if (!GA_ID || !window.dataLayer) return;
  gtag('event', 'page_view', {
    page_path: path,
    page_location: window.location.href,
    page_title: document.title,
  });
}
