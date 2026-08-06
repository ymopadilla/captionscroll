import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { tierAtLeast } from '../lib/tiers';
import { useAuth } from './useAuth';

/**
 * Loads the signed-in user's subscription tier from public.users.
 * Falls back to 'free' when signed out or on error.
 */
export function useSubscription() {
  const { user } = useAuth();
  const [tier, setTier] = useState('free');
  const [loading, setLoading] = useState(true);
  // Monotonic fetch counter: only the LATEST refresh may write state.
  // Without it, the mount-time fetch can resolve after a post-checkout
  // refresh and overwrite the fresh paid tier with a stale 'free'.
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    if (!user) {
      setTier('free');
      setLoading(false);
      return 'free';
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('users')
      .select('subscription_tier')
      .eq('id', user.id)
      .maybeSingle();
    const next = !error && data ? data.subscription_tier : 'free';
    if (seq === seqRef.current) {
      // A newer refresh is in flight otherwise — let it own the state.
      setTier(next);
      setLoading(false);
    }
    return next;
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    tier,
    loading,
    refresh,
    /** e.g. isAtLeast('starter') — true for starter and pro users */
    isAtLeast: (required) => tierAtLeast(tier, required),
  };
}
