import { useCallback, useEffect, useState } from 'react';
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

  const refresh = useCallback(async () => {
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
    setTier(next);
    setLoading(false);
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
