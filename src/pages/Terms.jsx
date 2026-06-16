import LegalLayout, { LegalSection } from '../components/LegalLayout.jsx';

// NOTE: Plain-language starting template, not legal advice. Review with counsel and
// update contact / company details before relying on it.
const CONTACT = 'alerlunai@gmail.com';

export default function Terms() {
  return (
    <LegalLayout title="Terms of Service" lastUpdated="June 3, 2026">
      <p>
        These terms govern your use of SiteForge. By creating an account or using the
        service you agree to them.
      </p>

      <LegalSection heading="The service">
        <p>SiteForge helps you find local businesses, generate single-file websites with
          AI, and manage leads. Features and limits may change over time.</p>
      </LegalSection>

      <LegalSection heading="Accounts">
        <p>You are responsible for your account credentials and all activity under your
          account. Provide accurate information and keep your password secure.</p>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <ul className="list-disc pl-5 space-y-1">
          <li>Do not use the service for unlawful, deceptive, or abusive purposes.</li>
          <li>Do not attempt to bypass rate limits, plan limits, or security controls.</li>
          <li>Respect third-party rights and applicable anti-spam laws when contacting leads.</li>
          <li>You are responsible for how you use generated websites and lead data.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Plans & billing">
        <p>Free and Pro plans carry monthly usage limits shown in the app. Pro is billed
          through Stripe on a recurring basis at the price displayed at checkout. You can
          manage or cancel your subscription from the billing portal; fees already charged
          are non-refundable except where required by law.</p>
      </LegalSection>

      <LegalSection heading="Generated content">
        <p>You own the websites you generate and may use them commercially. AI output may
          be imperfect or resemble other output — review and test before delivering it to a
          client. You are responsible for the final result.</p>
      </LegalSection>

      <LegalSection heading="Third-party services">
        <p>The service relies on Supabase, Vercel, Stripe, Anthropic, and Google. Their
          availability and terms are outside our control.</p>
      </LegalSection>

      <LegalSection heading="Disclaimers & liability">
        <p>The service is provided “as is” without warranties. To the maximum extent
          permitted by law, SiteForge is not liable for indirect or consequential damages,
          and total liability is limited to the amount you paid in the prior 12 months.</p>
      </LegalSection>

      <LegalSection heading="Termination">
        <p>You may stop using the service at any time. We may suspend or terminate accounts
          that violate these terms.</p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>We may update these terms; material changes will be reflected by the “last
          updated” date. Continued use means you accept the revised terms.</p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>Questions? Email <a className="text-accent" href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
      </LegalSection>
    </LegalLayout>
  );
}
