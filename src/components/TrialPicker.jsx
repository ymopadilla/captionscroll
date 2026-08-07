import { useState } from 'react';
import { TIER_LABELS, TRIAL_DAYS } from '../lib/tiers';

const CARDS = [
  {
    tier: 'starter',
    tagline: 'All you need to record',
    features: [
      'Unlimited video recording',
      'Script-based captions (100% accurate)',
      'Basic green screen (blur + solid colors)',
      'Video download',
    ],
  },
  {
    tier: 'pro',
    tagline: 'Everything unlocked',
    features: [
      'Everything in Starter',
      'Speech-to-text caption sync',
      'Custom backgrounds & video filters',
      'Multiple takes + social export',
    ],
  },
];

/**
 * One-time tier picker shown to brand-new users: try Starter or Pro
 * free for 14 days, no credit card. The choice is permanent (the
 * user_trials primary key rejects a second trial), so the copy says so.
 */
export default function TrialPicker({ startTrial, onStarted, onDismiss }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const choose = async (tier) => {
    setBusy(tier);
    setError('');
    try {
      await startTrial(tier);
      onStarted?.(tier);
    } catch (err) {
      setError(err.message || 'Could not start your trial. Please try again.');
      setBusy('');
    }
  };

  return (
    <div
      className="trial-picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trial-picker-title"
    >
      <div className="trial-picker">
        <h2 id="trial-picker-title">
          Try CaptionScroll free for {TRIAL_DAYS} days
        </h2>
        <p className="trial-picker-sub">
          Choose your tier — full access, no credit card required. You get one
          free trial, so pick the tier you want to explore.
        </p>

        <div className="trial-cards">
          {CARDS.map((c) => (
            <div key={c.tier} className={`trial-card trial-card-${c.tier}`}>
              <h3>{TIER_LABELS[c.tier]}</h3>
              <p className="trial-card-tagline">{c.tagline}</p>
              <ul>
                {c.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <button
                className={`trial-choose trial-choose-${c.tier}`}
                disabled={Boolean(busy)}
                onClick={() => choose(c.tier)}
              >
                {busy === c.tier ? 'Starting…' : `Try ${TIER_LABELS[c.tier]}`}
              </button>
            </div>
          ))}
        </div>

        {error && <p className="trial-picker-error">{error}</p>}

        <button
          className="trial-picker-skip"
          disabled={Boolean(busy)}
          onClick={onDismiss}
        >
          No thanks — continue with Free (practice only)
        </button>
      </div>
    </div>
  );
}
