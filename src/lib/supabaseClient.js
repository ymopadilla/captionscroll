import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Surfaced in the console rather than crashing the whole app.
  console.error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY environment variables.'
  );
}

// Sessions persist to localStorage by default, so users stay logged in
// across refreshes and browser restarts.
export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '');
