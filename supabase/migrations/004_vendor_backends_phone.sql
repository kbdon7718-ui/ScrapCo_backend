-- ScrapCo (Customer Backend)
-- Adds a phone column to vendor_backends so customer UI can show vendor contact.
-- Safe to re-run.

alter table if exists public.vendor_backends
  add column if not exists phone text;
