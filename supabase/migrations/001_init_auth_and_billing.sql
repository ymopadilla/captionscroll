-- ============================================================
-- SpeakScroll — initial schema: users, scripts, subscriptions
-- Run this in the Supabase SQL Editor of the SpeakScroll project
-- (https://rgpgascbdmbpkgsmgnmx.supabase.co). Safe to run once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text unique not null,
  subscription_tier text not null default 'free'
    check (subscription_tier in ('free', 'starter', 'pro')),
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null default 'Untitled script',
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_scripts_user_id_idx
  on public.user_scripts (user_id);

create table if not exists public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  stripe_subscription_id text unique,
  stripe_product_id text,
  tier text not null check (tier in ('starter', 'pro')),
  billing_cycle text not null check (billing_cycle in ('monthly', 'annual')),
  -- 'trialing' included because Starter and Pro start with a 14-day trial
  status text not null default 'active'
    check (status in ('trialing', 'active', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_subscriptions_user_id_idx
  on public.user_subscriptions (user_id);

-- ------------------------------------------------------------
-- 2. updated_at maintenance
-- ------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists set_user_scripts_updated_at on public.user_scripts;
create trigger set_user_scripts_updated_at
  before update on public.user_scripts
  for each row execute function public.set_updated_at();

drop trigger if exists set_user_subscriptions_updated_at on public.user_subscriptions;
create trigger set_user_subscriptions_updated_at
  before update on public.user_subscriptions
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 3. Auto-create a public.users row on signup
--    (security definer so it can insert despite RLS)
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 4. Row Level Security — everything private by default
-- ------------------------------------------------------------

alter table public.users enable row level security;
alter table public.user_scripts enable row level security;
alter table public.user_subscriptions enable row level security;

-- users: read + update own record only (no client-side insert/delete;
-- rows are created by the signup trigger, tier changes come from the
-- server using the service-role key, which bypasses RLS)
drop policy if exists "users_select_own" on public.users;
create policy "users_select_own"
  on public.users for select
  using (auth.uid() = id);

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own"
  on public.users for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- clients may not grant themselves a paid tier; the server
    -- (service role) performs tier upgrades after Stripe confirms payment
    and subscription_tier = (select u.subscription_tier
                             from public.users u
                             where u.id = auth.uid())
  );

-- user_scripts: full CRUD on own scripts only
drop policy if exists "scripts_select_own" on public.user_scripts;
create policy "scripts_select_own"
  on public.user_scripts for select
  using (auth.uid() = user_id);

drop policy if exists "scripts_insert_own" on public.user_scripts;
create policy "scripts_insert_own"
  on public.user_scripts for insert
  with check (auth.uid() = user_id);

drop policy if exists "scripts_update_own" on public.user_scripts;
create policy "scripts_update_own"
  on public.user_scripts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "scripts_delete_own" on public.user_scripts;
create policy "scripts_delete_own"
  on public.user_scripts for delete
  using (auth.uid() = user_id);

-- user_subscriptions: read own only (writes come from the server)
drop policy if exists "subs_select_own" on public.user_subscriptions;
create policy "subs_select_own"
  on public.user_subscriptions for select
  using (auth.uid() = user_id);
