import { Link } from 'react-router-dom';
import logo from '../lib/img/siteforge_mark_128.png';

export default function Landing() {
  return (
    <div className="min-h-screen grid-bg text-text">
      {/* ── Header ── */}
      <header className="border-b border-border sticky top-0 z-10 bg-bg/90 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-5 py-4 flex items-center justify-between">
          <img src={logo} alt="SiteForge" className="h-8 w-auto" />
          <nav className="flex items-center gap-2 sm:gap-3">
            <Link to="/login" className="font-mono text-xs sm:text-sm uppercase text-muted hover:text-text transition-colors">Login</Link>
            <Link to="/signup" className="btn-primary text-xs sm:text-sm">Get Started</Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="max-w-6xl mx-auto px-5 pt-16 pb-20 sm:pt-24 sm:pb-24">
        <h1 className="font-mono text-4xl sm:text-5xl md:text-6xl leading-tight tracking-tight max-w-4xl">
          Build websites for local businesses.
          <br />
          <span className="text-accent">In minutes.</span>
        </h1>
        <p className="mt-6 text-base sm:text-lg text-muted max-w-2xl leading-relaxed">
          Find businesses without a website, generate one with AI, download the file,
          and pitch the owner. SiteForge runs the whole loop in one workspace.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link to="/signup" className="btn-primary">Get Started Free</Link>
          <a href="#how" className="btn">See How It Works</a>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how" className="border-t border-border bg-surface">
        <div className="max-w-6xl mx-auto px-5 py-16 sm:py-20">
          <div className="label mb-10">how it works</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Step
              n="01"
              title="Find a business on Google Maps"
              body="Use the lead scraper to surface local businesses with no website."
            />
            <Step
              n="02"
              title="Paste their info into the chat"
              body="Claude generates a complete, single-file website tailored to the business."
            />
            <Step
              n="03"
              title="Download and close the deal"
              body="Download the HTML, send a preview, get paid, mark the lead as sold."
            />
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section className="border-t border-border">
        <div className="max-w-6xl mx-auto px-5 py-16 sm:py-20">
          <div className="label mb-10">pricing</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-3xl">
            <PriceCard
              name="FREE"
              price="$0"
              cadence="forever"
              features={[
                '68k credits / month',
                '10 leads / month',
                'Full-screen preview',
                'Download HTML',
              ]}
              cta="Start Free"
              to="/signup"
              primary={false}
            />
            <PriceCard
              name="PRO"
              price="$29.99"
              cadence="per month"
              features={[
                '680k credits / month',
                '100 leads / month',
                'Full-screen preview',
                'Download HTML',
                'Lead export to CSV',
              ]}
              cta="Get Pro"
              to="/signup"
              primary
            />
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-5 py-8 font-mono text-xs text-muted flex flex-wrap gap-x-6 gap-y-2 items-center justify-between">
          <span>SiteForge {new Date().getFullYear()}</span>
          <span className="flex gap-4">
            <Link to="/privacy" className="hover:text-text transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-text transition-colors">Terms</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

function Step({ n, title, body }) {
  return (
    <div className="bg-bg border border-border p-6 flex flex-col gap-4 hover:border-accent/40 transition-colors" style={{ borderRadius: 2 }}>
      <div
        className="w-10 h-10 flex items-center justify-center border border-accent/30 bg-accent/5 shrink-0"
        style={{ borderRadius: 2 }}
      >
        <span className="font-mono text-accent text-sm font-medium">{n}</span>
      </div>
      <div>
        <div className="font-mono text-sm text-text leading-snug mb-2">{title}</div>
        <div className="text-sm text-muted leading-relaxed">{body}</div>
      </div>
    </div>
  );
}

function PriceCard({ name, price, cadence, features, cta, to, primary }) {
  return (
    <div className={`card p-7 flex flex-col relative ${primary ? 'border-accent' : ''}`}>
      {primary && (
        <div className="absolute -top-px left-6 right-6 h-px bg-accent" />
      )}
      {primary && (
        <div className="absolute -top-3 left-6">
          <span className="font-mono text-[10px] uppercase tracking-widest bg-accent text-black px-2 py-0.5" style={{ borderRadius: 2 }}>
            Popular
          </span>
        </div>
      )}
      <div className="font-mono uppercase tracking-widest text-xs text-muted">{name}</div>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="font-mono text-4xl sm:text-5xl text-text">{price}</span>
        <span className="font-mono text-xs text-muted">{cadence}</span>
      </div>
      <div className="mt-1 h-px bg-border" />
      <ul className="mt-5 space-y-2.5 flex-1">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm">
            <span className="text-accent font-mono mt-0.5 shrink-0">+</span>
            <span className="text-muted">{f}</span>
          </li>
        ))}
      </ul>
      <Link
        to={to}
        className={`mt-8 inline-block text-center ${primary ? 'btn-primary' : 'btn'}`}
        style={{ display: 'block' }}
      >
        {cta}
      </Link>
    </div>
  );
}
