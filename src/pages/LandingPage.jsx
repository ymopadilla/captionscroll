import { Link } from 'react-router-dom';
import NavHeader from '../components/NavHeader';
import SiteFooter from '../components/SiteFooter';
import usePageMeta from '../lib/usePageMeta';
import './site.css';

const FEATURES = [
  {
    icon: '🎬',
    iconLabel: 'Professional teleprompter icon',
    title: 'Professional Teleprompter',
    body: 'Read scripts confidently without stumbling. Adjustable speed, font size, and mirror mode keep you in control.',
  },
  {
    icon: '💬',
    iconLabel: 'Caption embedding icon',
    title: 'Perfect Captions',
    body: 'Script-based captions embedded right into your video — 100% accurate, no transcription errors, ever.',
  },
  {
    icon: '🖼️',
    iconLabel: 'Green screen background icon',
    title: 'Green Screen',
    body: 'Look polished anywhere. Blur your background, swap in a solid color, or upload your own backdrop.',
  },
  {
    icon: '🎯',
    iconLabel: 'One-take confidence target icon',
    title: 'One-Take Confidence',
    body: 'Nail your delivery in 1–2 attempts, not 20. Record, review, and download broadcast-ready video.',
  },
];

const FAQS = [
  {
    q: 'What makes CaptionScroll different from other teleprompter apps?',
    a: 'CaptionScroll embeds your actual script as video captions — not AI-generated captions. Since you wrote the script, the captions are 100% accurate, with zero transcription errors.',
  },
  {
    q: 'Do I need to install anything?',
    a: 'No. CaptionScroll works entirely in your web browser — no app download required.',
  },
  {
    q: "What's included in the free plan?",
    a: 'Unlimited teleprompter practice, camera preview, and full reading controls. Video recording requires a Starter or Pro subscription.',
  },
  {
    q: 'How does the 14-day free trial work?',
    a: 'When you subscribe to Starter or Pro, you get 14 days of full access before any charge. Cancel anytime during the trial with no cost.',
  },
  {
    q: 'Can I use CaptionScroll for YouTube or TikTok videos?',
    a: 'Yes. CaptionScroll works for any platform — YouTube, TikTok, Instagram, LinkedIn, or internal training videos.',
  },
  {
    q: "What's the difference between Starter and Pro?",
    a: 'Starter includes unlimited recording, script-based captions, and basic green screen. Pro adds speech-to-text caption sync, advanced green screen with custom backgrounds, video filters, multiple takes, and one-click social export.',
  },
  {
    q: 'Is my script or video data private?',
    a: (
      <>
        Yes. Your scripts and recordings are private to your account. See our{' '}
        <Link to="/privacy">Privacy Policy</Link> for full details.
      </>
    ),
  },
];

export default function LandingPage() {
  usePageMeta(
    'CaptionScroll — Your script. Perfect captions.',
    'CaptionScroll is a professional teleprompter for educators, trainers & speakers. Record video with 100% accurate captions embedded — no AI transcription errors, ever.'
  );

  return (
    <div className="site-page">
      <NavHeader />

      {/* Hero */}
      <header className="hero">
        <div className="hero-banner-wrap">
          <img
            src="/hero-banner.jpg"
            alt="Flowing light streams over a blue and purple gradient"
            className="hero-image"
          />
          <div className="hero-banner-overlay">
            <img
              src="/captionscroll-icon.png"
              alt="CaptionScroll logo"
              className="hero-logo"
            />
            <span className="hero-brand">CaptionScroll</span>
          </div>
        </div>
        <div className="hero-content">
          <h1 className="hero-headline">Your Script. Perfect Captions.</h1>
          <p className="hero-subheadline">Plan. Deliver. Perfect.</p>
          <p className="hero-tagline">
            Professional teleprompter for educators, trainers, and speakers
          </p>
          <Link to="/signup" className="hero-cta">
            Get Started Free
          </Link>
        </div>
      </header>

      {/* Features */}
      <section className="features">
        {FEATURES.map((f) => (
          <div className="feature-card" key={f.title}>
            <div className="feature-icon" role="img" aria-label={f.iconLabel}>
              {f.icon}
            </div>
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      {/* FAQ */}
      <section className="home-faq">
        <h2 className="faq-title">Frequently asked questions</h2>
        <div className="faq-list">
          {FAQS.map((f) => (
            <details className="faq-item" key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        <p className="compare-link">
          Wondering how we stack up?{' '}
          <Link to="/compare">See how CaptionScroll compares →</Link>
        </p>
      </section>

      {/* Call to action */}
      <section className="cta-band">
        <h2>Ready to deliver like a pro?</h2>
        <Link to="/signup" className="hero-cta">
          Start Free Today
        </Link>
      </section>

      {/* Footer */}
      <SiteFooter />
    </div>
  );
}
