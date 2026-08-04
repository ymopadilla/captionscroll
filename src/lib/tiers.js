/**
 * Single source of truth for subscription tiers, Stripe products,
 * and pricing shown in the UI.
 *
 * NOTE: these are Stripe PRODUCT ids (test mode). The serverless
 * function /api/create-checkout-session resolves the active recurring
 * price for a product at runtime, so no price ids are hardcoded.
 */

export const TIERS = ['free', 'starter', 'pro'];

export const TIER_RANK = { free: 0, starter: 1, pro: 2 };

/** True when `tier` grants at least the access of `required`. */
export function tierAtLeast(tier, required) {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[required] ?? 0);
}

export const TRIAL_DAYS = 14;

export const STRIPE_PRODUCTS = {
  starter: {
    monthly: 'prod_V0Yvm3n3eidvjD',
    annual: 'prod_V0Z65x8g6nlEz2',
  },
  pro: {
    monthly: 'prod_V0ZxEZPSd45imy',
    annual: 'prod_V0a2XEe2BBCtyo',
  },
};

export const PRICING = {
  starter: { monthly: 7.99, annual: 60 },
  pro: { monthly: 14.99, annual: 99 },
};

export const TIER_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro' };
