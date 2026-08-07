import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/verify-session
 * Body: { sessionId }
 *
 * Called after Stripe Checkout redirects back with a session_id.
 * Verifies the session with Stripe (the client cannot fake a paid or
 * trialing session), then updates the user's tier in Supabase using
 * the service-role key.
 *
 * Requires env vars (set in Vercel):
 *   STRIPE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   VITE_SUPABASE_URL (already present for the frontend build)
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secretKey || !supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({
      error:
        'Server is missing STRIPE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_URL.',
    });
  }

  const { sessionId } = req.body ?? {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId.' });
  }

  const stripe = new Stripe(secretKey);
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    if (session.status !== 'complete') {
      return res
        .status(402)
        .json({ error: `Checkout not complete (status: ${session.status}).` });
    }

    const userId = session.metadata?.userId || session.client_reference_id;
    const tier = session.metadata?.tier;
    const cycle = session.metadata?.cycle;
    const productId = session.metadata?.productId;

    if (!userId || !['starter', 'pro'].includes(tier)) {
      return res.status(400).json({ error: 'Session missing user metadata.' });
    }

    const subscription = session.subscription;
    const subStatus =
      subscription && typeof subscription === 'object'
        ? subscription.status // 'trialing' during the 14-day trial
        : 'active';
    const entitled = ['trialing', 'active', 'past_due'].includes(subStatus);
    if (!entitled) {
      return res
        .status(402)
        .json({ error: `Subscription is not active (${subStatus}).` });
    }

    // 1. Upgrade the user's tier + store their Stripe customer id.
    const { error: userErr } = await supabase
      .from('users')
      .update({
        subscription_tier: tier,
        stripe_customer_id:
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id ?? null,
      })
      .eq('id', userId);
    if (userErr) throw new Error(`Supabase users update: ${userErr.message}`);

    // 2. Record the subscription row (idempotent on stripe_subscription_id).
    const subId =
      typeof subscription === 'object' && subscription
        ? subscription.id
        : subscription;
    if (subId) {
      const { error: subErr } = await supabase
        .from('user_subscriptions')
        .upsert(
          {
            user_id: userId,
            stripe_subscription_id: subId,
            stripe_product_id: productId ?? null,
            tier,
            billing_cycle: cycle === 'annual' ? 'annual' : 'monthly',
            status: subStatus === 'trialing' ? 'trialing' : 'active',
          },
          { onConflict: 'stripe_subscription_id' }
        );
      if (subErr)
        throw new Error(`Supabase user_subscriptions upsert: ${subErr.message}`);
    }

    // 3. A no-card trial converts on payment: mark it consumed so the
    //    client derives subscription_status 'active' (not 'trial') and
    //    the trial can never be re-entered. Best-effort — the table may
    //    not exist until migration 002 runs, and payment already
    //    succeeded either way.
    try {
      await supabase
        .from('user_trials')
        .update({ trial_active: false })
        .eq('user_id', userId);
    } catch {
      /* non-fatal */
    }

    return res.status(200).json({ tier, status: subStatus });
  } catch (err) {
    console.error('verify-session error:', err);
    return res
      .status(500)
      .json({ error: err.message || 'Could not verify checkout session.' });
  }
}
