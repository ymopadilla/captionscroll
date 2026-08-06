import NavHeader from '../components/NavHeader';
import SiteFooter from '../components/SiteFooter';
import usePageMeta from '../lib/usePageMeta';
import './site.css';

/** Privacy Policy — content approved August 2026. */
export default function PrivacyPage() {
  usePageMeta(
    'Privacy Policy — CaptionScroll',
    'Learn how CaptionScroll collects, uses, and protects your data, including account, billing, and script information.'
  );

  return (
    <div className="site-page">
      <NavHeader />

      <main className="legal-main">
        <h1>Privacy Policy</h1>
        <p className="legal-meta">
          <strong>Effective Date:</strong> August 2026
        </p>
        <p className="legal-meta">
          <strong>Last Updated:</strong> August 2026
        </p>

        <p className="legal-intro">
          Digital Navigation Solutions LLC (&ldquo;Company,&rdquo;
          &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) operates
          CaptionScroll (the &ldquo;Service&rdquo;). This Privacy Policy explains
          what information we collect, how we use it, and your rights regarding
          that information.
        </p>

        <h2>1. Information We Collect</h2>
        <p>
          <strong>Account Information:</strong> When you create an account, we
          collect your email address and a securely hashed password (via
          Supabase Authentication).
        </p>
        <p>
          <strong>Payment Information:</strong> When you subscribe to a paid
          plan, payment is processed by Stripe, Inc. We do not collect or store
          your full credit card number. We receive limited billing information
          from Stripe, such as your subscription status and billing history.
        </p>
        <p>
          <strong>User Content:</strong> Scripts you write and save, and any
          video/audio you choose to record using the Service. Recorded video is
          processed in your browser and downloaded directly to your device; we
          do not store your recorded videos on our servers unless you
          explicitly use a feature that saves them.
        </p>
        <p>
          <strong>Usage Data:</strong> Basic technical information such as
          browser type, device type, and general usage patterns, used to
          improve the Service and diagnose issues.
        </p>

        <h2>2. How We Use Your Information</h2>
        <p>We use the information we collect to:</p>
        <ul>
          <li>Provide, maintain, and improve the Service;</li>
          <li>Process payments and manage your subscription;</li>
          <li>
            Communicate with you about your account, billing, or updates to the
            Service;
          </li>
          <li>Respond to support requests;</li>
          <li>
            Detect, prevent, and address technical issues or fraudulent
            activity.
          </li>
        </ul>
        <p>We do not sell your personal information to third parties.</p>

        <h2>3. Third-Party Service Providers</h2>
        <p>
          We rely on the following third-party providers to operate the
          Service:
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> — authentication and database hosting
          </li>
          <li>
            <strong>Stripe</strong> — payment processing and subscription
            billing
          </li>
          <li>
            <strong>Vercel</strong> — application hosting and deployment
          </li>
        </ul>
        <p>
          These providers process data on our behalf and are contractually
          obligated to protect it in accordance with industry standards. Please
          review their respective privacy policies for more detail on how they
          handle data.
        </p>

        <h2>4. Data Security</h2>
        <p>
          We implement reasonable technical and organizational measures to
          protect your information, including encrypted data transmission
          (HTTPS), database-level access controls (Row Level Security), and
          secure authentication practices. However, no method of transmission
          or storage is 100% secure, and we cannot guarantee absolute security.
        </p>

        <h2>5. Data Retention</h2>
        <p>
          We retain your account information and User Content for as long as
          your account is active. If you delete your account, we will delete or
          anonymize your personal information within a reasonable period,
          except where retention is required for legal, billing, or
          fraud-prevention purposes.
        </p>

        <h2>6. Your Rights</h2>
        <p>Depending on your location, you may have the right to:</p>
        <ul>
          <li>Access the personal information we hold about you;</li>
          <li>Request correction of inaccurate information;</li>
          <li>Request deletion of your account and associated data;</li>
          <li>
            Object to or restrict certain processing of your information.
          </li>
        </ul>
        <p>
          To exercise any of these rights, contact us at{' '}
          <a href="mailto:support@digitalnavigationsolutions.com">
            support@digitalnavigationsolutions.com
          </a>
          .
        </p>

        <h2>7. Cookies and Tracking</h2>
        <p>
          The Service may use essential cookies necessary for authentication
          and basic functionality (for example, keeping you logged in). We do
          not currently use third-party advertising or tracking cookies.
        </p>

        <h2>8. Children&rsquo;s Privacy</h2>
        <p>
          The Service is not directed to individuals under the age of 18. We do
          not knowingly collect personal information from children. If we
          become aware that we have inadvertently collected such information,
          we will take steps to delete it.
        </p>

        <h2>9. International Users</h2>
        <p>
          The Service is operated from the United States. If you access the
          Service from outside the United States, you understand that your
          information will be transferred to and processed in the United
          States, which may have different data protection laws than your
          jurisdiction.
        </p>

        <h2>10. Changes to This Privacy Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. Material changes
          will be communicated via the Service or by email. Continued use of
          the Service after changes take effect constitutes acceptance of the
          revised policy.
        </p>

        <h2>11. Contact Us</h2>
        <p>
          Questions about this Privacy Policy or how we handle your data?
          Contact us at{' '}
          <a href="mailto:support@digitalnavigationsolutions.com">
            support@digitalnavigationsolutions.com
          </a>
          .
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
