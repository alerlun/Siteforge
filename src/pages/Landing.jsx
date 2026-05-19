import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div className="min-h-screen grid-bg text-text">
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="font-mono uppercase tracking-widest text-sm">
            Site<span className="text-accent">Forge</span>
          </div>
          <nav className="flex items-center gap-3">
            <Link to="/login" className="font-mono text-sm uppercase text-muted hover:text-text">Login</Link>
            <Link to="/signup" className="btn-primary">Get Started</Link>
          </nav>
        </div>
      </header>

      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20">
        <h1 className="font-mono text-5xl md:text-6xl leading-tight tracking-tight max-w-4xl">
          Build websites for local businesses.
          <br />
          <span className="text-accent">In minutes.</span>
        </h1>
        <p className="mt-6 text-lg text-muted max-w-2xl">
          Find businesses without a website, generate one with AI, download the file,
          and pitch the owner. SiteForge runs the whole loop in one workspace.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link to="/signup" className="btn-primary">Get Started Free</Link>
          <a href="#how" className="btn">See How It Works</a>
        </div>
      </section>

      <section id="how" className="border-t border-border bg-surface">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="label mb-6">how it works</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
            <Step n="01" title="Find a business on Google Maps" body="Use the lead scraper to surface local businesses with no website." />
            <Step n="02" title="Paste their info into the chat" body="Claude generates a complete, single-file website tailored to the business." />
            <Step n="03" title="Download and close the deal" body="Download the HTML, send a preview, get paid, mark the lead as sold." />
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="label mb-6">pricing</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <PriceCard
              name="FREE"
              price="$0"
              cadence="forever"
              features={[
                '3 website generations / month',
                '100 leads / month',
                'Full-screen preview',
                'Download HTML',
              ]}
              cta="Start Free"
              to="/signup"
              primary={false}
            />
            <PriceCard
              name="PRO"
              price="$19.99"
              cadence="per month"
              features={[
                '10 website generations / month',
                '1,000 leads / month',
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

      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-6 py-8 font-mono text-xs text-muted flex justify-between">
          <span>SiteForge © {new Date().getFullYear()}</span>
          <span>built for freelancers and agencies</span>
        </div>
      </footer>
    </div>
  );
}

function Step({ n, title, body }) {
  return (
    <div className="bg-surface p-6">
      <div className="font-mono text-accent text-sm">{n}</div>
      <div className="font-mono mt-2 text-base">{title}</div>
      <div className="mt-3 text-sm text-muted">{body}</div>
    </div>
  );
}

function PriceCard({ name, price, cadence, features, cta, to, primary }) {
  return (
    <div className={`card p-8 ${primary ? 'border-accent' : ''}`}>
      <div className="font-mono uppercase tracking-widest text-xs text-muted">{name}</div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-mono text-4xl">{price}</span>
        <span className="font-mono text-sm text-muted">{cadence}</span>
      </div>
      <ul className="mt-6 space-y-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="text-accent font-mono">+</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link to={to} className={`mt-8 inline-block ${primary ? 'btn-primary' : 'btn'}`}>{cta}</Link>
    </div>
  );
}
