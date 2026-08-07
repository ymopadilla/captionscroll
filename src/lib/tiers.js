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

const DAY_MS = 86400000;

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whole days left in a trial window, never negative.
 * 14 right after starting, 1 on the last day, 0 once expired.
 */
export function trialDaysRemaining(endsAt, now = new Date()) {
  const end = toDate(endsAt);
  if (!end) return 0;
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

/** True once the trial window has fully passed. */
export function trialEnded(endsAt, now = new Date()) {
  const end = toDate(endsAt);
  return Boolean(end) && end.getTime() <= now.getTime();
}

/**
 * Human phrasing for how long ago a trial ended:
 * "today", "yesterday", "5 days ago", "2 weeks ago".
 */
export function endedAgoText(endsAt, now = new Date()) {
  const end = toDate(endsAt);
  if (!end) return 'recently';
  const days = Math.floor((now.getTime() - end.getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? 'a week ago' : `${weeks} weeks ago`;
}

export const PRICING = {
  starter: { monthly: 7.99, annual: 60 },
  pro: { monthly: 14.99, annual: 99 },
};

export const TIER_LABELS = { free: 'Free', starter: 'Starter', pro: 'Pro' };
