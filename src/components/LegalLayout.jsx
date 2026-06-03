import { Link } from 'react-router-dom';

// Shared shell for the Privacy and Terms pages: app header, readable prose column,
// footer with cross-links so each legal doc is one click from the other (and from home).
export default function LegalLayout({ title, lastUpdated, children }) {
  return (
    <div className="min-h-screen grid-bg text-text">
      <header className="border-b border-border">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link to="/" className="font-mono uppercase tracking-widest text-sm">
            Site<span className="text-accent">Forge</span>
          </Link>
          <nav className="flex items-center gap-4 font-mono text-xs uppercase text-muted">
            <Link to="/privacy" className="hover:text-text">Privacy</Link>
            <Link to="/terms" className="hover:text-text">Terms</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="font-mono text-3xl tracking-tight">{title}</h1>
        {lastUpdated && (
          <p className="mt-2 font-mono text-xs uppercase tracking-widest text-muted">
            Last updated: {lastUpdated}
          </p>
        )}
        <div className="legal-prose mt-8 space-y-6 text-sm leading-relaxed text-muted">
          {children}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="max-w-3xl mx-auto px-6 py-8 font-mono text-xs text-muted flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <span>SiteForge © {new Date().getFullYear()}</span>
          <span className="flex gap-4">
            <Link to="/" className="hover:text-text">Home</Link>
            <Link to="/privacy" className="hover:text-text">Privacy</Link>
            <Link to="/terms" className="hover:text-text">Terms</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

// Small heading used inside legal pages.
export function LegalSection({ heading, children }) {
  return (
    <section>
      <h2 className="font-mono text-base text-text">{heading}</h2>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}
