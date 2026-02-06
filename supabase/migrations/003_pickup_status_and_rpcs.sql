-- Adds ON_THE_WAY status and expands customer RPCs so cancel/delete works
-- without requiring a service-role key in the Node backend.

-- 1) Add new status to enum (idempotent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pickup_status') THEN
    BEGIN
      ALTER TYPE public.pickup_status ADD VALUE IF NOT EXISTS 'ON_THE_WAY';
    EXCEPTION
      WHEN duplicate_object THEN
        -- already exists
        NULL;
    END;
  END IF;
END $$;

-- 2) Cancel pickup RPC (expanded)
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
        cancelled_at = now(),
        assigned_vendor_ref = null,
        assignment_expires_at = null
  where id = p_pickup_id
    and customer_id = auth.uid()
    and status <> 'COMPLETED';
end;
$$;

grant execute on function public.cancel_pickup(uuid) to authenticated;

-- 3) Find vendor again RPC
create or replace function public.find_vendor_again(p_pickup_id uuid)
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
    set status = 'FINDING_VENDOR',
        assigned_vendor_ref = null,
        assignment_expires_at = null,
        cancelled_at = null
  where id = p_pickup_id
    and customer_id = auth.uid()
    and status not in ('ASSIGNED', 'ON_THE_WAY', 'CANCELLED', 'COMPLETED');
end;
$$;

grant execute on function public.find_vendor_again(uuid) to authenticated;
