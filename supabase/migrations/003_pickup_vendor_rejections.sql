-- ScrapCo (Customer Backend) - Record vendor rejections
-- Apply this in Supabase SQL editor AFTER 002_dispatcher_vendor_tables.sql
--
-- Purpose:
-- - Persist which vendors have rejected a given pickup
-- - Enables dispatcher to skip those vendors on redispatch / server restarts

create table if not exists public.pickup_vendor_rejections (
  pickup_id uuid not null references public.pickups(id) on delete cascade,
  vendor_ref text not null,
  rejected_at timestamptz not null default now(),
  primary key (pickup_id, vendor_ref)
);

create index if not exists idx_pickup_vendor_rejections_pickup_id
  on public.pickup_vendor_rejections(pickup_id);
