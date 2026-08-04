import NavHeader from '../components/NavHeader';
import SiteFooter from '../components/SiteFooter';
import './site.css';

/** Terms of Service — content approved August 2026. */
export default function TermsPage() {
  return (
    <div className="site-page">
      <NavHeader />

      <main className="legal-main">
        <h1>Terms of Service</h1>
        <p className="legal-meta">
          <strong>Effective Date:</strong> August 2026
        </p>
        <p className="legal-meta">
          <strong>Last Updated:</strong> August 2026
        </p>

        <p className="legal-intro">
          Welcome to SpeakScroll, a product of Digital Navigation Solutions LLC
          (&ldquo;Company,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
          &ldquo;our&rdquo;). These Terms of Service (&ldquo;Terms&rdquo;)
          govern your access to and use of the SpeakScroll website,
          application, and related services (collectively, the
          &ldquo;Service&rdquo;). By creating an account or using the Service,
          you agree to these Terms. If you do not agree, do not use the
          Service.
        </p>

        <h2>1. Description of Service</h2>
        <p>
          SpeakScroll is a web-based teleprompter application that allows users
          to write scripts, read them aloud using an on-screen scrolling
          display, and optionally record video with the script text embedded as
          captions. The Service is offered on a freemium basis with paid
          subscription tiers (&ldquo;Starter&rdquo; and &ldquo;Pro&rdquo;) that
          unlock additional features.
        </p>

        <h2>2. Eligibility</h2>
        <p>
          You must be at least 18 years old, or the age of legal majority in
          your jurisdiction, to create an account and use the Service. By using
          the Service, you represent that you meet this requirement.
        </p>

        <h2>3. Account Registration</h2>
        <p>
          To access most features, you must create an account using a valid
          email address and password. You are responsible for maintaining the
          confidentiality of your login credentials and for all activity that
          occurs under your account. Notify us immediately at{' '}
          <a href="mailto:support@digitalnavigationsolutions.com">
            support@digitalnavigationsolutions.com
          </a>{' '}
          if you suspect unauthorized use of your account.
        </p>

        <h2>4. Subscription Plans, Billing, and Free Trials</h2>
        <ul>
          <li>
            SpeakScroll offers a Free tier and two paid tiers: Starter and Pro,
            each available on monthly or annual billing.
          </li>
          <li>
            Paid tiers include a 14-day free trial. You will not be charged
            during the trial period. If you do not cancel before the trial
            ends, your payment method will be automatically charged at the
            then-current rate for your selected plan.
          </li>
          <li>
            Subscriptions automatically renew at the end of each billing period
            unless cancelled prior to renewal.
          </li>
          <li>
            You may cancel your subscription at any time through your account
            settings. Cancellation takes effect at the end of the current
            billing period; you will retain access to paid features until that
            date.
          </li>
          <li>
            All payments are processed securely through Stripe, Inc. We do not
            store your full payment card details on our servers.
          </li>
          <li>
            Prices are subject to change with reasonable advance notice posted
            on the Service or sent to your account email.
          </li>
        </ul>

        <h2>5. Refunds</h2>
        <p>
          Except where required by applicable law, subscription fees are
          non-refundable, including for partial billing periods. If you believe
          you were charged in error, contact{' '}
          <a href="mailto:support@digitalnavigationsolutions.com">
            support@digitalnavigationsolutions.com
          </a>{' '}
          and we will review your request in good faith.
        </p>

        <h2>6. User Content</h2>
        <p>
          You retain full ownership of the scripts, text, video recordings, and
          other content you create or upload using the Service (&ldquo;User
          Content&rdquo;). By using the Service, you grant us a limited license
          to store, process, and transmit your User Content solely as necessary
          to operate and provide the Service to you (for example, storing your
          scripts so you can retrieve them, or processing video frames during
          recording). We do not claim ownership of your User Content and will
          not use it for any purpose beyond providing the Service, unless you
          separately and explicitly agree otherwise.
        </p>
        <p>
          You are solely responsible for your User Content and confirm that you
          have the right to use, record, and distribute it, and that it does
          not violate any law or infringe any third party&rsquo;s rights.
        </p>

        <h2>7. Acceptable Use</h2>
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>
            Create, record, or distribute unlawful, defamatory, obscene, or
            infringing content;
          </li>
          <li>Violate the intellectual property or privacy rights of others;</li>
          <li>
            Attempt to gain unauthorized access to the Service, other accounts,
            or our systems;
          </li>
          <li>
            Interfere with or disrupt the integrity or performance of the
            Service;
          </li>
          <li>Use the Service to harass, abuse, or harm another person.</li>
        </ul>
        <p>
          We reserve the right to suspend or terminate accounts that violate
          these Terms.
        </p>

        <h2>8. Third-Party Services</h2>
        <p>
          The Service integrates with third-party providers, including Stripe
          (payments) and Supabase (authentication and data storage). Your use
          of the Service is also subject to those providers&rsquo; respective
          terms and privacy policies where applicable.
        </p>

        <h2>9. Intellectual Property</h2>
        <p>
          The Service, including its software, design, branding, and underlying
          technology, is owned by Digital Navigation Solutions LLC and
          protected by applicable intellectual property laws. These Terms do
          not grant you any rights to our trademarks, logos, or brand assets.
        </p>

        <h2>10. Disclaimer of Warranties</h2>
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as
          available&rdquo; without warranties of any kind, express or implied,
          including but not limited to warranties of merchantability, fitness
          for a particular purpose, or non-infringement. We do not guarantee
          that the Service will be uninterrupted, error-free, or completely
          secure.
        </p>

        <h2>11. Limitation of Liability</h2>
        <p>
          To the fullest extent permitted by law, Digital Navigation Solutions
          LLC shall not be liable for any indirect, incidental, special,
          consequential, or punitive damages arising out of or related to your
          use of the Service, even if advised of the possibility of such
          damages. Our total liability for any claim arising from these Terms
          or the Service shall not exceed the amount you paid us in the twelve
          (12) months preceding the claim.
        </p>

        <h2>12. Termination</h2>
        <p>
          We may suspend or terminate your access to the Service at any time
          for violation of these Terms. You may stop using the Service and
          delete your account at any time by contacting{' '}
          <a href="mailto:support@digitalnavigationsolutions.com">
            support@digitalnavigationsolutions.com
          </a>
          .
        </p>

        <h2>13. Changes to These Terms</h2>
        <p>
          We may update these Terms from time to time. Material changes will be
          communicated via the Service or by email. Continued use of the
          Service after changes take effect constitutes acceptance of the
          revised Terms.
        </p>

        <h2>14. Governing Law</h2>
        <p>
          These Terms are governed by the laws of the State of Colorado, United
          States, without regard to its conflict of law principles.
        </p>

        <h2>15. Contact Us</h2>
        <p>
          Questions about these Terms? Contact us at{' '}
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
