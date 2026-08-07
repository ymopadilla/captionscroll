-- ============================================================
-- CaptionScroll — 14-day no-card trials: public.user_trials
-- Run this in the Supabase SQL Editor AFTER
-- 001_init_auth_and_billing.sql. Safe to run once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Table — one trial per user, ever (primary key = user_id).
--    The tier choice is locked to the FIRST choice: the PK stops
--    a second row and there is no client delete/replace policy.
-- ------------------------------------------------------------

create table if not exists public.user_trials (
  user_id uuid primary key references public.users (id) on delete cascade,
  trial_tier text not null check (trial_tier in ('starter', 'pro')),
  trial_start_date timestamptz not null default now(),
  trial_end_date timestamptz not null default (now() + interval '14 days'),
  trial_active boolean not null default true,
  -- Email captured at trial start for reminder/upgrade comms, even if
  -- the auth email later changes.
  original_email_for_comms text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. updated_at maintenance (function created in migration 001)
-- ------------------------------------------------------------

drop trigger if exists set_user_trials_updated_at on public.user_trials;
create trigger set_user_trials_updated_at
  before update on public.user_trials
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 3. Server-authoritative trial window — whatever the client
--    sends on insert, the 14-day window is stamped server-side
--    so nobody can hand-pick their own end date.
-- ------------------------------------------------------------

create or replace function public.enforce_trial_window()
returns trigger
language plpgsql
as $$
begin
  new.trial_start_date := now();
  new.trial_end_date := now() + interval '14 days';
  new.trial_active := true;
  return new;
end;
$$;

drop trigger if exists enforce_trial_window on public.user_trials;
create trigger enforce_trial_window
  before insert on public.user_trials
  for each row execute function public.enforce_trial_window();

-- ------------------------------------------------------------
-- 4. Row Level Security
-- ------------------------------------------------------------

alter table public.user_trials enable row level security;

-- Read own trial only.
drop policy if exists "trials_select_own" on public.user_trials;
create policy "trials_select_own"
  on public.user_trials for select
  using (auth.uid() = user_id);

-- Start own trial (once — the primary key rejects a second insert;
-- the trigger above stamps the dates regardless of what was sent).
drop policy if exists "trials_insert_own" on public.user_trials;
create policy "trials_insert_own"
  on public.user_trials for insert
  with check (
    auth.uid() = user_id
    and trial_tier in ('starter', 'pro')
  );

-- Clients may only flip trial_active true → false (the app's
-- expiration bookkeeping on load). Reactivating, changing the tier,
-- or moving the window stays impossible; conversions to paid are
-- written by the server with the service-role key (bypasses RLS).
drop policy if exists "trials_deactivate_own" on public.user_trials;
create policy "trials_deactivate_own"
  on public.user_trials for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and trial_active = false
    and trial_tier = (select t.trial_tier
                      from public.user_trials t
                      where t.user_id = auth.uid())
    and trial_start_date = (select t.trial_start_date
                            from public.user_trials t
                            where t.user_id = auth.uid())
    and trial_end_date = (select t.trial_end_date
                          from public.user_trials t
                          where t.user_id = auth.uid())
  );

-- No delete policy: trials cannot be removed (and so cannot be retaken).
