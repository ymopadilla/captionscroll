import { Link } from 'react-router-dom';
import { TIER_LABELS, tierAtLeast } from '../lib/tiers';

/**
 * Wraps a feature that requires a minimum tier.
 *
 * <SubscriptionGate tier={tier} requires="starter" message="...">
 *   <RecordButton />
 * </SubscriptionGate>
 *
 * mode="hide"    — renders an upsell instead of the children
 * mode="overlay" — renders children dimmed + a lock overlay (default)
 */
export default function SubscriptionGate({
  tier,
  requires,
  message,
  mode = 'overlay',
  children,
}) {
  if (tierAtLeast(tier, requires)) return children;

  const upsell = message || `Upgrade to ${TIER_LABELS[requires]} to use this feature`;

  if (mode === 'hide') {
    return (
      <Link to="/pricing" className="gate-upsell-link">
        🔒 {upsell}
      </Link>
    );
  }

  return (
    <div className="gate-wrapper">
      <div className="gate-locked-content" aria-disabled="true">
        {children}
      </div>
      <Link to="/pricing" className="gate-overlay" title={upsell}>
        <span className="gate-lock">🔒</span>
        <span className="gate-message">{upsell}</span>
      </Link>
    </div>
  );
}
