-- ScrapCo (Customer Backend) - Dispatcher support
-- Apply this in Supabase SQL editor AFTER 001_customer_rls_and_rpc.sql
--
-- Adds:
-- - pickup status values used by dispatcher
-- - vendor_backends table to store latest vendor location + offer endpoint

-- 1) Ensure pickup status supports dispatcher states
DO $$
BEGIN
  -- If pickup status is an enum type named pickup_status, add new values.
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pickup_status') THEN
    BEGIN
      ALTER TYPE pickup_status ADD VALUE IF NOT EXISTS 'FINDING_VENDOR';
    EXCEPTION WHEN duplicate_object THEN
      -- ignore
    END;
    BEGIN
      ALTER TYPE pickup_status ADD VALUE IF NOT EXISTS 'NO_VENDOR_AVAILABLE';
    EXCEPTION WHEN duplicate_object THEN
      -- ignore
    END;
  END IF;
END $$;

-- 2) Vendors registry (single source of truth in CUSTOMER DB)
CREATE TABLE IF NOT EXISTS public.vendor_backends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_ref text NOT NULL UNIQUE,
  name text,
  offer_url text,
  last_latitude numeric,
  last_longitude numeric,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Optional: index for active vendors
CREATE INDEX IF NOT EXISTS idx_vendor_backends_active ON public.vendor_backends(active);

-- Note: We do NOT enable RLS on vendor_backends here.
-- Only the CUSTOMER BACKEND should write to it using service role.
