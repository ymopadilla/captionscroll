import { Link } from 'react-router-dom';
import NavHeader from '../components/NavHeader';
import SiteFooter from '../components/SiteFooter';
import './site.css';

const FEATURES = [
  {
    icon: '🎬',
    title: 'Professional Teleprompter',
    body: 'Read scripts confidently without stumbling. Adjustable speed, font size, and mirror mode keep you in control.',
  },
  {
    icon: '💬',
    title: 'Perfect Captions',
    body: 'Script-based captions embedded right into your video — 100% accurate, no transcription errors, ever.',
  },
  {
    icon: '🖼️',
    title: 'Green Screen',
    body: 'Look polished anywhere. Blur your background, swap in a solid color, or upload your own backdrop.',
  },
  {
    icon: '🎯',
    title: 'One-Take Confidence',
    body: 'Nail your delivery in 1–2 attempts, not 20. Record, review, and download broadcast-ready video.',
  },
];

export default function LandingPage() {
  return (
    <div className="site-page">
      <NavHeader />

      {/* Hero */}
      <header className="hero">
        <img
          src="/hero-banner.png"
          alt="SpeakScroll"
          className="hero-image"
        />
        <h1 className="hero-headline">Speak Clearly. Flow Naturally.</h1>
        <p className="hero-subheadline">Plan. Deliver. Perfect.</p>
        <p className="hero-tagline">
          Professional teleprompter for educators, trainers, and speakers
        </p>
        <Link to="/signup" className="hero-cta">
          Get Started Free
        </Link>
      </header>

      {/* Features */}
      <section className="features">
        {FEATURES.map((f) => (
          <div className="feature-card" key={f.title}>
            <div className="feature-icon" aria-hidden="true">
              {f.icon}
            </div>
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </div>
        ))}
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
