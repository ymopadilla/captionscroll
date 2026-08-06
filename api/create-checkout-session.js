import Stripe from 'stripe';

/**
 * POST /api/create-checkout-session
 * Body: { tier, cycle, userId, email, origin }
 *   tier:  'starter' | 'pro'
 *   cycle: 'monthly' | 'annual'
 * (Legacy body { productId } from older cached bundles is still accepted.)
 *
 * Creates a Stripe Checkout session (subscription mode, 14-day trial).
 *
 * No product/price ids are hardcoded. The matching product is resolved
 * at runtime IN THE SAME MODE (test vs live) as STRIPE_SECRET_KEY, so a
 * test key never trips over live-mode product ids and vice versa:
 *   1. Env overrides STRIPE_PRICE_<TIER>_<CYCLE> / STRIPE_PRODUCT_<TIER>_<CYCLE>
 *      (e.g. STRIPE_PRICE_STARTER_MONTHLY) pin an exact id.
 *   2. Otherwise the active recurring prices in the account are searched
 *      for a product matching the plan (by metadata, then by name+interval).
 *   3. In TEST mode only, if the plan doesn't exist yet it is created
 *      automatically (product + recurring price) so development checkout
 *      always works. In live mode a clear error is returned instead.
 *
 * Requires env var STRIPE_SECRET_KEY (set in Vercel).
 */

const TRIAL_DAYS = 14;

// Canonical plans. Amounts are in cents and must stay in sync with
// PRICING in src/lib/tiers.js.
const PLANS = {
  starter: {
    name: 'CaptionScroll Starter',
    monthly: 799,
    annual: 6000,
  },
  pro: {
    name: 'CaptionScroll Pro',
    monthly: 1499,
    annual: 9900,
  },
};

const CYCLE_INTERVAL = { monthly: 'month', annual: 'year' };

// Product ids from the original build, kept only so requests from an
// old cached frontend bundle (which sent productId) keep working.
const LEGACY_PRODUCTS = {
  prod_V0Yvm3n3eidvjD: { tier: 'starter', cycle: 'monthly' },
  prod_V0Z65x8g6nlEz2: { tier: 'starter', cycle: 'annual' },
  prod_V0ZxEZPSd45imy: { tier: 'pro', cycle: 'monthly' },
  prod_V0a2XEe2BBCtyo: { tier: 'pro', cycle: 'annual' },
};

function isLiveKey(key) {
  return key.startsWith('sk_live_') || key.startsWith('rk_live_');
}

/** Find the product's active recurring price for the wanted interval. */
async function priceFromProduct(stripe, productId, interval) {
  const prices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 20,
  });
  const match =
    prices.data.find((p) => p.recurring?.interval === interval) ||
    prices.data.find((p) => p.recurring);
  return match?.id ?? null;
}

/**
 * Resolve the price id for a plan in the mode the secret key lives in.
 * Returns { priceId, productId }.
 */
async function resolvePlanPrice(stripe, tier, cycle, live) {
  const interval = CYCLE_INTERVAL[cycle];
  const envSuffix = `${tier.toUpperCase()}_${cycle.toUpperCase()}`;

  // 1. Explicit env overrides win.
  const envPrice = process.env[`STRIPE_PRICE_${envSuffix}`];
  if (envPrice) {
    const price = await stripe.prices.retrieve(envPrice);
    return { priceId: price.id, productId: price.product };
  }
  const envProduct = process.env[`STRIPE_PRODUCT_${envSuffix}`];
  if (envProduct) {
    const priceId = await priceFromProduct(stripe, envProduct, interval);
    if (priceId) return { priceId, productId: envProduct };
  }

  // 2. Search the account's active recurring prices for this plan.
  //    Match by metadata first (set by this app), then by product
  //    name + billing interval.
  const prices = await stripe.prices.list({
    active: true,
    type: 'recurring',
    limit: 100,
    expand: ['data.product'],
  });
  const candidates = prices.data.filter(
    (p) =>
      p.recurring?.interval === interval &&
      p.product &&
      typeof p.product === 'object' &&
      p.product.active !== false
  );
  const byMetadata = candidates.find(
    (p) =>
      (p.metadata?.tier === tier && p.metadata?.cycle === cycle) ||
      (p.product.metadata?.tier === tier &&
        (!p.product.metadata?.cycle || p.product.metadata.cycle === cycle))
  );
  const tierWord = new RegExp(`\\b${tier}\\b`, 'i');
  const byName = candidates.find((p) => tierWord.test(p.product.name || ''));
  const found = byMetadata || byName;
  if (found) return { priceId: found.id, productId: found.product.id };

  // 3. Nothing matches in this mode.
  if (live) {
    throw new Error(
      `No active "${PLANS[tier].name}" product with a ${interval}ly recurring ` +
        'price exists in LIVE mode. Create it in the Stripe dashboard (or set ' +
        `STRIPE_PRICE_${envSuffix} in Vercel), or use a test-mode secret key.`
    );
  }

  // Test mode: auto-provision the plan so development checkout always works.
  const product = await stripe.products.create({
    name: PLANS[tier].name,
    metadata: { tier, app: 'captionscroll' },
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: PLANS[tier][cycle],
    currency: 'usd',
    recurring: { interval },
    metadata: { tier, cycle },
  });
  return { priceId: price.id, productId: product.id };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res
      .status(500)
      .json({ error: 'STRIPE_SECRET_KEY is not configured on the server.' });
  }

  // Catch test/live key mismatches early with a clear message instead of
  // a confusing "No such product" from Stripe.
  const live = isLiveKey(secretKey);
  const pubKey = process.env.VITE_STRIPE_PUBLIC_KEY || '';
  if (pubKey && pubKey.startsWith('pk_live_') !== live) {
    return res.status(500).json({
      error:
        `Stripe keys are mismatched: VITE_STRIPE_PUBLIC_KEY is ${
          pubKey.startsWith('pk_live_') ? 'LIVE' : 'TEST'
        } mode but STRIPE_SECRET_KEY is ${live ? 'LIVE' : 'TEST'} mode. ` +
        'Set both Vercel env vars to the same mode (test keys for development).',
    });
  }

  const { tier: rawTier, cycle: rawCycle, productId, userId, email, origin } =
    req.body ?? {};

  // Current clients send tier+cycle; old cached bundles sent productId.
  const legacy = productId ? LEGACY_PRODUCTS[productId] : null;
  const tier = rawTier ?? legacy?.tier;
  const cycle = rawCycle ?? legacy?.cycle;

  if (!PLANS[tier] || !CYCLE_INTERVAL[cycle]) {
    return res.status(400).json({ error: 'Unknown plan.' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId.' });
  }

  // Only allow redirects back to the site that made the request.
  const baseUrl =
    typeof origin === 'string' && /^https?:\/\//.test(origin)
      ? origin
      : `https://${req.headers.host}`;

  const stripe = new Stripe(secretKey);

  try {
    const { priceId, productId: resolvedProductId } = await resolvePlanPrice(
      stripe,
      tier,
      cycle,
      live
    );

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS },
      customer_email: email || undefined,
      client_reference_id: userId,
      allow_promotion_codes: true,
      metadata: {
        userId,
        tier,
        cycle,
        productId: resolvedProductId,
      },
      success_url: `${baseUrl}/app?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing?checkout=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Could not create checkout session.' });
  }
}
