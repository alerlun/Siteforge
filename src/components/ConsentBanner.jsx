import { useState } from 'react';
import { Link } from 'react-router-dom';
import { grantConsent, denyConsent, storedConsent } from '../lib/analytics.js';

// Cookie-consent bar. GA is not loaded until Accept. Shows only when no prior choice exists
// and a GA measurement ID is configured. Accept → GA loads with analytics_storage granted
// (ads denied); Decline → never loads. Choice persists in localStorage.
export default function ConsentBanner() {
  const hasGa = Boolean(import.meta.env.VITE_GA_MEASUREMENT_ID);
  const [decided, setDecided] = useState(() => storedConsent() !== null);

  if (!hasGa || decided) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="fixed bottom-0 inset-x-0 z-50 border-t border-border bg-surface"
    >
      <div className="max-w-6xl mx-auto px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <p className="text-sm text-muted">
          We use analytics cookies to understand how SiteForge is used. You can accept or
          decline. See our{' '}
          <Link to="/privacy" className="text-accent">Privacy Policy</Link>.
        </p>
        <div className="flex gap-2 shrink-0">
          <button
            className="btn"
            onClick={() => { denyConsent(); setDecided(true); }}
          >
            Decline
          </button>
          <button
            className="btn-primary"
            onClick={() => { grantConsent(); setDecided(true); }}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
