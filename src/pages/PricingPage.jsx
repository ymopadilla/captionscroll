import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import NavHeader from '../components/NavHeader';
import SiteFooter from '../components/SiteFooter';
import StripeCheckout from '../components/StripeCheckout';
import { PRICING } from '../lib/tiers';
import './site.css';

const COMPARISON = [
  ['Unlimited practice reading', true, true, true],
  ['Teleprompter controls (speed, font, mirror)', true, true, true],
  ['Camera preview (draggable PIP)', true, true, true],
  ['Unlimited video recording', false, true, true],
  ['Script-based captions (100% accurate)', false, true, true],
  ['Basic green screen (blur + solid colors)', false, true, true],
  ['Video download (MP4/WebM)', false, true, true],
  ['Speech-to-text caption sync', false, false, true],
  ['Advanced green screen (custom backgrounds)', false, false, true],
  ['Video filters', false, false, true],
  ['Multiple takes manager', false, false, true],
  ['Social export (YouTube, TikTok, Instagram, LinkedIn)', false, false, true],
  ['Transcript export', false, false, true],
];

const FAQS = [
  {
    q: "What's the difference between Starter and Pro?",
    a: 'Starter covers everything you need to record professional videos: unlimited recording, script-based captions, basic green screen, and downloads. Pro adds creator-grade tools — speech-to-text caption sync, custom green screen backgrounds, video filters, a multiple-takes manager, social exports, and transcript export.',
  },
  {
    q: 'Can I change plans anytime?',
    a: 'Yes. You can upgrade, downgrade, or cancel at any time. Upgrades take effect immediately; downgrades and cancellations apply at the end of your current billing period.',
  },
  {
    q: 'How does the 14-day free trial work?',
    a: "Both Starter and Pro start with a 14-day free trial. You won't be charged until the trial ends, and you can cancel anytime before then at no cost.",
  },
  {
    q: 'What payment methods do you accept?',
    a: 'We accept all major credit and debit cards through Stripe, our secure payment processor.',
  },
  {
    q: 'Do you offer refunds?',
    a: "If something isn't working for you, contact us within 14 days of a charge and we'll make it right.",
  },
];

function Check({ on }) {
  return on ? (
    <span className="cmp-yes" aria-label="Included">✓</span>
  ) : (
    <span className="cmp-no" aria-label="Not included">✕</span>
  );
}

export default function PricingPage() {
  const [cycle, setCycle] = useState('monthly');
  const [searchParams] = useSearchParams();
  const cancelled = searchParams.get('checkout') === 'cancelled';

  const price = (tier) =>
    cycle === 'monthly'
      ? `$${PRICING[tier].monthly}/month`
      : `$${PRICING[tier].annual}/year`;

  return (
    <div className="site-page">
      <NavHeader />

      <main className="pricing-main">
        <h1>Simple, honest pricing</h1>
        <p className="pricing-sub">
          Start free. Upgrade when you're ready to record — every paid plan
          begins with a 14-day free trial.
        </p>

        {cancelled && (
          <p className="pricing-cancelled">
            Checkout was cancelled — no charge was made. Pick a plan whenever
            you're ready.
          </p>
        )}

        {/* Billing cycle toggle */}
        <div className="cycle-toggle" role="group" aria-label="Billing cycle">
          <button
            className={cycle === 'monthly' ? 'active' : ''}
            onClick={() => setCycle('monthly')}
          >
            Monthly
          </button>
          <button
            className={cycle === 'annual' ? 'active' : ''}
            onClick={() => setCycle('annual')}
          >
            Annual <span className="cycle-save">save up to 45%</span>
          </button>
        </div>

        {/* Tier cards */}
        <div className="pricing-grid">
          {/* FREE */}
          <div className="price-card">
            <h2>Free</h2>
            <p className="price-amount">$0</p>
            <p className="price-billing">Always free</p>
            <ul className="price-features">
              <li>Unlimited practice reading</li>
              <li>Teleprompter controls (speed, font, mirror)</li>
              <li>See yourself via camera preview</li>
            </ul>
            <p className="price-desc">Perfect for learning, not for recording yet</p>
            <Link to="/signup" className="price-btn secondary">
              Get Started
            </Link>
          </div>

          {/* STARTER */}
          <div className="price-card featured">
            <div className="price-badge">Most Popular</div>
            <h2>Starter</h2>
            <p className="price-amount">{price('starter')}</p>
            <p className="price-billing">14-day free trial, cancel anytime</p>
            <ul className="price-features">
              <li>Everything in Free</li>
              <li>Unlimited video recording</li>
              <li>Script-based captions (100% accurate)</li>
              <li>Basic green screen (blur + solid colors)</li>
              <li>Video download</li>
            </ul>
            <p className="price-desc">All you need to create professional videos</p>
            <StripeCheckout tier="starter" cycle={cycle} className="price-btn primary">
              Start Free Trial
            </StripeCheckout>
          </div>

          {/* PRO */}
          <div className="price-card">
            <div className="price-badge pro">Professional</div>
            <h2>Pro</h2>
            <p className="price-amount">{price('pro')}</p>
            <p className="price-billing">14-day free trial, cancel anytime</p>
            <ul className="price-features">
              <li>Everything in Starter</li>
              <li>Speech-to-text caption sync</li>
              <li>Advanced green screen (custom backgrounds)</li>
              <li>Video filters</li>
              <li>Multiple takes manager</li>
              <li>Social export (YouTube, TikTok, Instagram, LinkedIn)</li>
              <li>Transcript export</li>
            </ul>
            <p className="price-desc">
              Broadcast-quality video creation for serious creators
            </p>
            <StripeCheckout tier="pro" cycle={cycle} className="price-btn primary">
              Start Free Trial
            </StripeCheckout>
          </div>
        </div>

        {/* Comparison table */}
        <h2 className="cmp-title">Compare plans</h2>
        <div className="cmp-scroll">
          <table className="cmp-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Free</th>
                <th>Starter</th>
                <th>Pro</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map(([feature, free, starter, pro]) => (
                <tr key={feature}>
                  <td>{feature}</td>
                  <td><Check on={free} /></td>
                  <td><Check on={starter} /></td>
                  <td><Check on={pro} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* FAQ */}
        <h2 className="faq-title">Frequently asked questions</h2>
        <div className="faq-list">
          {FAQS.map((f) => (
            <details className="faq-item" key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
