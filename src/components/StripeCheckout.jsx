import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TIERS } from '../lib/tiers';
import { useAuth } from '../hooks/useAuth';

/**
 * Starts a Stripe Checkout for a tier + billing cycle by asking the
 * serverless function for a hosted checkout URL, then redirecting.
 *
 * The client only sends the plan (tier + cycle); the server resolves
 * the matching Stripe product/price in whatever mode (test or live)
 * its secret key is in, so no product ids are hardcoded here.
 */
export async function startCheckout({ tier, cycle, user }) {
  if (!TIERS.includes(tier) || !['monthly', 'annual'].includes(cycle)) {
    throw new Error(`Unknown plan: ${tier}/${cycle}`);
  }

  const res = await fetch('/api/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tier,
      cycle,
      userId: user.id,
      email: user.email,
      origin: window.location.origin,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    throw new Error(data.error || 'Could not start checkout.');
  }
  window.location.assign(data.url);
}

/**
 * "Upgrade" button. If the visitor is signed out, sends them to signup
 * first (with the intended plan remembered in the URL).
 */
export default function StripeCheckout({
  tier,
  cycle,
  className = '',
  children,
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleClick = async () => {
    setError('');
    if (!user) {
      navigate(`/signup?plan=${tier}&cycle=${cycle}`);
      return;
    }
    setBusy(true);
    try {
      await startCheckout({ tier, cycle, user });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <>
      <button className={className} onClick={handleClick} disabled={busy}>
        {busy ? 'Opening checkout…' : children}
      </button>
      {error && <p className="checkout-error">{error}</p>}
    </>
  );
}
