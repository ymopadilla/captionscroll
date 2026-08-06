import Stripe from 'stripe';

/**
 * POST /api/create-checkout-session
 * Body: { productId, userId, email, origin }
 *
 * Creates a Stripe Checkout session (subscription mode, 14-day trial)
 * for one of the four known CaptionScroll products. Price ids are
 * resolved at runtime from the product, so nothing is hardcoded.
 *
 * Requires env var STRIPE_SECRET_KEY (set in Vercel).
 */

const TRIAL_DAYS = 14;

// Allowlist: product id -> tier + billing cycle
const KNOWN_PRODUCTS = {
  prod_V0Yvm3n3eidvjD: { tier: 'starter', cycle: 'monthly' },
  prod_V0Z65x8g6nlEz2: { tier: 'starter', cycle: 'annual' },
  prod_V0ZxEZPSd45imy: { tier: 'pro', cycle: 'monthly' },
  prod_V0a2XEe2BBCtyo: { tier: 'pro', cycle: 'annual' },
};

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

  const { productId, userId, email, origin } = req.body ?? {};
  const product = KNOWN_PRODUCTS[productId];
  if (!product) {
    return res.status(400).json({ error: 'Unknown product.' });
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
    // Resolve the product's active recurring price at runtime.
    const stripeProduct = await stripe.products.retrieve(productId);
    let priceId =
      typeof stripeProduct.default_price === 'string'
        ? stripeProduct.default_price
        : stripeProduct.default_price?.id;

    if (!priceId) {
      const prices = await stripe.prices.list({
        product: productId,
        active: true,
        limit: 10,
      });
      priceId = prices.data.find((p) => p.recurring)?.id;
    }
    if (!priceId) {
      return res
        .status(500)
        .json({ error: 'No active price found for this product.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS },
      customer_email: email || undefined,
      client_reference_id: userId,
      allow_promotion_codes: true,
      metadata: {
        userId,
        tier: product.tier,
        cycle: product.cycle,
        productId,
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
