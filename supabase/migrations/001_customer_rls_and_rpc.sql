-- ScrapCo (Customer App) - RLS + RPC
-- Apply this in Supabase SQL editor.
--
-- Goals:
-- - Customers can only see/insert their own data
-- - Vendors do NOT get direct access via anon key
-- - Vendor backend should use service role for reads/updates
--
-- IMPORTANT: This assumes your tables already exist as provided.

-- ----------------------------
-- 1) Profiles auto-create
-- ----------------------------
-- One profile row per auth user.

-- NOTE (email-only auth): if your existing schema was created for phone OTP,
-- profiles.phone may be NOT NULL. Email/password signups have phone = NULL,
-- which can cause "Database error saving new user" during signup due to this trigger.
-- This block makes profiles.phone nullable when the column exists.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'phone'
  ) then
    begin
      execute 'alter table public.profiles alter column phone drop not null';
    exception when others then
      -- ignore if already nullable or if permissions differ
      null;
    end;
  end if;
end $$;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, phone, email, signup_source)
  values (
    new.id,
    'customer',
    coalesce(new.raw_user_meta_data->>'full_name', null),
    new.phone,
    new.email,
    'mobile'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Create trigger only if it doesn't exist
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'on_auth_user_created_profile'
  ) then
    create trigger on_auth_user_created_profile
    after insert on auth.users
    for each row execute procedure public.handle_new_user_profile();
  end if;
end $$;

-- ----------------------------
-- 2) Enable Row Level Security
-- ----------------------------
alter table public.profiles enable row level security;
alter table public.pickups enable row level security;
alter table public.pickup_items enable row level security;
alter table public.scrap_types enable row level security;
alter table public.scrap_rates enable row level security;

-- ----------------------------
-- 3) RLS policies
-- ----------------------------

-- NOTE: Postgres does not support CREATE POLICY IF NOT EXISTS.
-- Use DROP POLICY IF EXISTS for idempotency.

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "pickups_select_own" on public.pickups;
create policy "pickups_select_own"
on public.pickups
for select
to authenticated
using (customer_id = auth.uid());

drop policy if exists "pickup_items_select_own" on public.pickup_items;
create policy "pickup_items_select_own"
on public.pickup_items
for select
to authenticated
using (
  exists (
    select 1
    from public.pickups p
    where p.id = pickup_items.pickup_id
      and p.customer_id = auth.uid()
  )
);

drop policy if exists "scrap_types_public_read" on public.scrap_types;
create policy "scrap_types_public_read"
on public.scrap_types
for select
to anon, authenticated
using (true);

drop policy if exists "scrap_rates_public_read" on public.scrap_rates;
create policy "scrap_rates_public_read"
on public.scrap_rates
for select
to anon, authenticated
using (true);

-- ----------------------------
-- 4) RPC: create_pickup
-- ----------------------------

create or replace function public.create_pickup(
  p_address text,
  p_latitude numeric,
  p_longitude numeric,
  p_time_slot text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pickup_id uuid;
  v_item jsonb;
  v_scrap_type_id uuid;
  v_qty numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty array';
  end if;

  insert into public.pickups (customer_id, status, address, latitude, longitude, time_slot)
  values (auth.uid(), 'REQUESTED', p_address, p_latitude, p_longitude, p_time_slot)
  returning id into v_pickup_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_scrap_type_id := (v_item->>'scrapTypeId')::uuid;
    v_qty := (v_item->>'estimatedQuantity')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'estimatedQuantity must be > 0';
    end if;

    insert into public.pickup_items (pickup_id, scrap_type_id, estimated_quantity)
    values (v_pickup_id, v_scrap_type_id, v_qty);
  end loop;

  return v_pickup_id;
end;
$$;

grant execute on function public.create_pickup(text,numeric,numeric,text,jsonb) to authenticated;

-- ----------------------------
-- 5) Optional: cancel pickup RPC
-- ----------------------------
create or replace function public.cancel_pickup(p_pickup_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  update public.pickups
    set status = 'CANCELLED',
        cancelled_at = now()
  where id = p_pickup_id
    and customer_id = auth.uid()
    and status = 'REQUESTED';
end;
$$;

grant execute on function public.cancel_pickup(uuid) to authenticated;
