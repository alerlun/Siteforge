import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Cloudflare Turnstile widget for Supabase Auth captcha protection (AUDIT-APP.md M3).
// Supabase verifies the token server-side once captcha is enabled under
// Auth → Attack Protection. Without VITE_TURNSTILE_SITE_KEY nothing renders and forms
// work without a token, so this can ship before captcha is switched on.
//
// Tokens are single-use: call ref.reset() after every auth request.

export const CAPTCHA_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error('Could not load the captcha.'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

const Captcha = forwardRef(function Captcha({ onToken }, ref) {
  const containerRef = useRef(null);
  const widgetRef = useRef(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useImperativeHandle(ref, () => ({
    reset() {
      onTokenRef.current('');
      if (widgetRef.current != null) window.turnstile?.reset(widgetRef.current);
    },
  }), []);

  useEffect(() => {
    if (!CAPTCHA_SITE_KEY) return undefined;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetRef.current = turnstile.render(containerRef.current, {
          sitekey: CAPTCHA_SITE_KEY,
          theme: 'dark',
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(''),
          'error-callback': () => onTokenRef.current(''),
        });
      })
      .catch(() => onTokenRef.current(''));
    return () => {
      cancelled = true;
      if (widgetRef.current != null) window.turnstile?.remove(widgetRef.current);
      widgetRef.current = null;
    };
  }, []);

  if (!CAPTCHA_SITE_KEY) return null;
  return <div ref={containerRef} className="min-h-[65px]" />;
});

export default Captcha;
