import LegalLayout, { LegalSection } from '../components/LegalLayout.jsx';

// NOTE: This is a plain-language starting template, not legal advice. Review with
// counsel and update the contact address / company details before relying on it.
const CONTACT = 'alerlunai@gmail.com';

export default function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="June 3, 2026">
      <p>
        This policy explains what SiteForge collects, why, and the choices you have. By
        using SiteForge you agree to the handling of information described here.
      </p>

      <LegalSection heading="Information we collect">
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Account data</strong> — your email address and authentication details, via Supabase Auth.</li>
          <li><strong>Content you create</strong> — prompts, generated websites, and chat history.</li>
          <li><strong>Lead data</strong> — business listings you search for and save (names, addresses, phone numbers, ratings) sourced from Google Places.</li>
          <li><strong>Billing data</strong> — handled by Stripe; we store only a customer/subscription reference, never card numbers.</li>
          <li><strong>Usage analytics</strong> — only if you accept cookies (see below).</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Cookies & analytics">
        <p>
          We use Google Analytics 4 to understand product usage. Analytics cookies load in
          a default-denied state and record nothing until you click <strong>Accept</strong>
          on the consent banner. You can decline at any time; declining keeps the product
          fully functional. Essential cookies needed to keep you signed in are always set.
        </p>
      </LegalSection>

      <LegalSection heading="How we use information">
        <p>To operate the service, generate sites, enforce plan limits, process payments,
          provide support, and improve the product. We do not sell your personal data.</p>
      </LegalSection>

      <LegalSection heading="Third-party processors">
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Supabase</strong> — database, authentication, hosting of backend functions.</li>
          <li><strong>Vercel</strong> — frontend hosting and delivery.</li>
          <li><strong>Stripe</strong> — payment processing.</li>
          <li><strong>Anthropic</strong> — AI website generation (your prompts are sent to generate sites).</li>
          <li><strong>Google Places</strong> — business lead lookups.</li>
          <li><strong>Google Analytics</strong> — usage analytics (consent-gated).</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Data retention">
        <p>We keep account and content data while your account is active. You can delete
          your sites, leads, and chats in the app; deleting your account removes associated
          data, subject to records we must retain for legal or billing reasons.</p>
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>Depending on your location you may have rights to access, correct, export, or
          delete your personal data, and to withdraw analytics consent. Contact us to
          exercise them.</p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>Questions about privacy? Email <a className="text-accent" href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
      </LegalSection>
    </LegalLayout>
  );
}
