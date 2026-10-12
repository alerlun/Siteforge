// Google Analytics 4, loaded only after the user accepts analytics cookies.
//
// Loaded entirely from JS (no inline <script> in index.html) so the app's CSP can keep
// `script-src 'self' https://www.googletagmanager.com` without `'unsafe-inline'`. gtag.js
// is injected as an external script; the dataLayer pushes below run as same-origin module
// code, which CSP allows.
//
// Nothing is sent to Google before consent: gtag.js is not even requested until
// grantConsent() (the banner's Accept) or a stored 'granted' choice. Consent covers
// analytics only, so the ad signals stay denied. Page views are sent manually on route
// changes (send_page_view:false) because this is a client-side-routed SPA, without the
// query string (it can carry referral codes).

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const CONSENT_KEY = 'sf_ga_consent'; // 'granted' | 'denied'

let loaded = false;
let granted = false;

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

// Inject gtag.js with analytics consent. Safe to call more than once.
function loadGtag() {
  if (loaded || !GA_ID || typeof window === 'undefined') return;
  loaded = true;

  window.dataLayer = window.dataLayer || [];
  gtag('js', new Date());

  // Consent Mode v2: ads always denied; analytics granted (we only get here after consent).
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  });

  // Manual page_view (SPA): we fire them on route change via trackPageView().
  gtag('config', GA_ID, { send_page_view: false });

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);
}

// On app start: load GA only for returning visitors who already accepted.
export function initAnalytics() {
  if (storedConsent() === 'granted') {
    granted = true;
    loadGtag();
  }
}

export function grantConsent() {
  try { localStorage.setItem(CONSENT_KEY, 'granted'); } catch { /* ignore */ }
  if (!GA_ID) return;
  granted = true;
  if (loaded) {
    gtag('consent', 'update', { analytics_storage: 'granted' });
  } else {
    loadGtag();
  }
  // The page view for the current page was skipped before consent.
  trackPageView(window.location.pathname);
}

export function denyConsent() {
  try { localStorage.setItem(CONSENT_KEY, 'denied'); } catch { /* ignore */ }
  granted = false;
  if (loaded) gtag('consent', 'update', { analytics_storage: 'denied' });
}

// Send a SPA page view. No-op without consent. The query string is dropped.
export function trackPageView(path) {
  if (!GA_ID || !loaded || !granted) return;
  const pathname = String(path).split('?')[0];
  gtag('event', 'page_view', {
    page_path: pathname,
    page_location: window.location.origin + pathname,
    page_title: document.title,
  });
}
