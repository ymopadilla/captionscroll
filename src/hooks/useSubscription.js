import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { tierAtLeast, trialEnded, trialDaysRemaining, TRIAL_DAYS } from '../lib/tiers';
import { useAuth } from './useAuth';

/**
 * Loads the signed-in user's PAID tier (public.users.subscription_tier)
 * plus any 14-day no-card trial (public.user_trials), and derives the
 * EFFECTIVE tier used for feature gating.
 *
 * Derived state:
 *   tier                — 'free' | 'starter' | 'pro' (what they can USE now)
 *   paidTier            — the paid tier from public.users
 *   subscriptionStatus  — 'none' | 'trial' | 'active'
 *   trialDaysLeft       — number while in trial, else null
 *   trialExpiresAt      — Date | null
 *   trialExpired        — had a trial, it's over, and they haven't paid
 *   trialEligible       — definitively no trial record yet (may start one)
 *   startTrial(tier)    — creates the user_trials row (no card)
 *
 * The trial record is three-state on purpose:
 *   undefined — unknown (fetch failed / malformed response): behave
 *               exactly like the pre-trial app (no picker, no unlock)
 *   null      — definitively no record: user is trial-eligible
 *   object    — the record (may be active, converted, or expired)
 */

const DAY_MS = 86400000;

function normalizeTrial(data) {
  if (!Array.isArray(data)) return undefined; // unknown shape — not definitive
  const row = data[0];
  if (!row) return null; // definitively: no trial yet
  if (!['starter', 'pro'].includes(row.trial_tier)) return undefined;
  if (Number.isNaN(new Date(row.trial_end_date).getTime())) return undefined;
  return row;
}

function isTrialLive(trial) {
  return (
    Boolean(trial) &&
    trial.trial_active === true &&
    !trialEnded(trial.trial_end_date)
  );
}

function effectiveTier(paidTier, trial) {
  if (paidTier !== 'free') return paidTier;
  return isTrialLive(trial) ? trial.trial_tier : 'free';
}

export function useSubscription() {
  const { user } = useAuth();
  const [state, setState] = useState({ paidTier: 'free', trial: undefined });
  const [loading, setLoading] = useState(true);
  // Monotonic fetch counter: only the LATEST refresh may write state.
  // Without it, the mount-time fetch can resolve after a post-checkout
  // refresh and overwrite the fresh paid tier with a stale 'free'.
  const seqRef = useRef(0);
  // The expiry bookkeeping write fires at most once per session.
  const deactivatedRef = useRef(false);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    if (!user) {
      setState({ paidTier: 'free', trial: undefined });
      setLoading(false);
      return 'free';
    }
    setLoading(true);
    const [userRes, trialRes] = await Promise.all([
      supabase
        .from('users')
        .select('subscription_tier')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('user_trials')
        .select('trial_tier, trial_start_date, trial_end_date, trial_active')
        .eq('user_id', user.id)
        .limit(1),
    ]);
    const paidTier =
      !userRes.error && userRes.data ? userRes.data.subscription_tier : 'free';
    const trial = trialRes.error ? undefined : normalizeTrial(trialRes.data);
    if (seq === seqRef.current) {
      // A newer refresh is in flight otherwise — let it own the state.
      setState({ paidTier, trial });
      setLoading(false);
    }
    return effectiveTier(paidTier, trial);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Expiration bookkeeping: when the window has passed but the DB still
  // says trial_active=true, flip it off (RLS only permits true → false).
  // The UI locks from the date comparison either way, so this write is
  // best-effort record keeping, not the enforcement mechanism.
  useEffect(() => {
    const t = state.trial;
    if (
      deactivatedRef.current ||
      !user ||
      !t ||
      t.trial_active !== true ||
      !trialEnded(t.trial_end_date)
    ) {
      return;
    }
    deactivatedRef.current = true;
    supabase
      .from('user_trials')
      .update({ trial_active: false })
      .eq('user_id', user.id)
      .then(() => {}, () => {});
  }, [user, state.trial]);

  /** Start the one-and-only no-card trial. Locked to this first choice. */
  const startTrial = useCallback(
    async (chosenTier) => {
      if (!user) throw new Error('Please sign in first.');
      if (!['starter', 'pro'].includes(chosenTier)) {
        throw new Error(`Unknown tier: ${chosenTier}`);
      }
      const { data, error } = await supabase
        .from('user_trials')
        .insert({
          user_id: user.id,
          trial_tier: chosenTier,
          original_email_for_comms: user.email,
        })
        .select()
        .single();
      if (error) {
        // 23505 = unique violation: a trial already exists for this user.
        await refresh();
        throw new Error(
          error.code === '23505'
            ? 'Your account has already used its free trial.'
            : error.message || 'Could not start your trial. Please try again.'
        );
      }
      // Reflect immediately; invalidate any stale in-flight refresh so it
      // cannot clobber the fresh trial with pre-insert data.
      seqRef.current += 1;
      const row =
        normalizeTrial([data]) ?? {
          trial_tier: chosenTier,
          trial_start_date: new Date().toISOString(),
          trial_end_date: new Date(Date.now() + TRIAL_DAYS * DAY_MS).toISOString(),
          trial_active: true,
        };
      setState((s) => ({ ...s, trial: row }));
      setLoading(false);
      return row;
    },
    [user, refresh]
  );

  const { paidTier, trial } = state;
  const trialLive = paidTier === 'free' && isTrialLive(trial);
  const tier = effectiveTier(paidTier, trial);
  const subscriptionStatus =
    paidTier !== 'free' ? 'active' : trialLive ? 'trial' : 'none';

  return {
    tier,
    paidTier,
    subscriptionStatus,
    trialTier: trial ? trial.trial_tier : null,
    trialDaysLeft: trialLive ? trialDaysRemaining(trial.trial_end_date) : null,
    trialExpiresAt: trial ? new Date(trial.trial_end_date) : null,
    trialExpired: paidTier === 'free' && Boolean(trial) && !trialLive,
    trialEligible: paidTier === 'free' && trial === null,
    startTrial,
    loading,
    refresh,
    /** e.g. isAtLeast('starter') — true for starter and pro users */
    isAtLeast: (required) => tierAtLeast(tier, required),
  };
}
