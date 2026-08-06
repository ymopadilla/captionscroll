/**
 * Single source of truth for subscription tiers and pricing shown
 * in the UI.
 *
 * NOTE: no Stripe product/price ids live in the client. The serverless
 * function /api/create-checkout-session resolves the right product and
 * active recurring price at runtime for whatever mode (test or live)
 * the server's STRIPE_SECRET_KEY is in.
 */

export const TIERS = ['free', 'starter', 'pro'];

export const TIER_RANK = { free: 0, starter: 1, pro: 2 };

/** True when `tier` grants at least the access of `required`. */
export function tierAtLeast(tier, required) {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[required] ?? 0);
}

export const TRIAL_DAYS = 14;

export const PRICING = {
  starter: { monthly: 7.99, annual: 60 },
  pro: { monthly: 14.99, annual: 99 },
};

export const TIER_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro' };
