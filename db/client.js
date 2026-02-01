/**
 * backend/db/client.js
 *
 * PostgreSQL client using `pg` Pool.
 * Exports `query` and `initDb()` which creates the `pickups` table if it doesn't exist.
 */

const { Pool } = require('pg');

// Use DATABASE_URL from environment. If not set, the caller can skip DB usage.
const connectionString = process.env.DATABASE_URL || null;

let pool = null;

if (connectionString) {
  pool = new Pool({ connectionString });
}

async function initDb() {
  if (!pool) return;

  // Create extensions, types and tables matching the provided Supabase schema (practical variant)
  // Also seeds a few default scrap types/rates if the table is empty (so the dropdown isn't blank).
  const sql = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- pickup status enum
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pickup_status') THEN
        CREATE TYPE pickup_status AS ENUM (
          'REQUESTED',
          'FINDING_VENDOR',
          'ASSIGNED',
          'COMPLETED',
          'NO_VENDOR_AVAILABLE',
          'CANCELLED'
        );
      END IF;
    END$$;

    -- profiles: lightweight version (does not require auth.users to exist)
    CREATE TABLE IF NOT EXISTS profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role TEXT NOT NULL CHECK (role IN ('customer', 'admin')),
      full_name TEXT,
      phone TEXT,
      email TEXT,
      signup_source TEXT CHECK (signup_source IN ('web', 'mobile')) DEFAULT 'mobile',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- scrap types and rates
    CREATE TABLE IF NOT EXISTS scrap_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS scrap_rates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scrap_type_id UUID NOT NULL REFERENCES scrap_types(id) ON DELETE CASCADE,
      rate_per_kg NUMERIC(10,2) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      effective_from DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Seed default scrap types/rates for development if none exist
    DO $$
    BEGIN
      IF (SELECT COUNT(*) FROM scrap_types) = 0 THEN
        INSERT INTO scrap_types (name, description) VALUES
          ('Plastic', 'Plastic items'),
          ('Cardboard', 'Cardboard / cartons'),
          ('Metal', 'Metal scrap'),
          ('Paper', 'Paper scrap')
        ON CONFLICT (name) DO NOTHING;

        INSERT INTO scrap_rates (scrap_type_id, rate_per_kg, is_active, effective_from)
        SELECT st.id, v.rate_per_kg, true, CURRENT_DATE
        FROM (VALUES
          ('Plastic', 11.00::numeric),
          ('Cardboard', 12.00::numeric),
          ('Metal', 25.00::numeric),
          ('Paper', 8.00::numeric)
        ) AS v(name, rate_per_kg)
        JOIN scrap_types st ON st.name = v.name;
      END IF;
    END $$;

    -- pickups table
    CREATE TABLE IF NOT EXISTS pickups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES profiles(id),
      assigned_vendor_ref TEXT,
      assignment_expires_at TIMESTAMPTZ,
      status pickup_status NOT NULL DEFAULT 'REQUESTED',
      address TEXT NOT NULL,
      latitude NUMERIC(9,6),
      longitude NUMERIC(9,6),
      time_slot TEXT NOT NULL,
      cancelled_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pickup_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pickup_id UUID NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
      scrap_type_id UUID NOT NULL REFERENCES scrap_types(id),
      estimated_quantity NUMERIC(10,2) NOT NULL,
      actual_weight NUMERIC(10,2),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (pickup_id, scrap_type_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pickups_customer ON pickups(customer_id);
    CREATE INDEX IF NOT EXISTS idx_pickups_status ON pickups(status);
    CREATE INDEX IF NOT EXISTS idx_pickups_vendor ON pickups(assigned_vendor_ref);
    CREATE INDEX IF NOT EXISTS idx_pickup_items_pickup ON pickup_items(pickup_id);
  `;

  try {
    await pool.query(sql);
  } catch (err) {
    // If the DB host is unreachable (DNS or network error), do not crash the whole server.
    // Fall back to in-memory behavior by disabling the pool.
    console.warn('Database initialization failed — falling back to in-memory store:', err.message || err);
    try {
      await pool.end();
    } catch (e) {
      // ignore
    }
    pool = null;
  }
}

async function query(text, params) {
  if (!pool) throw new Error('Database not configured (DATABASE_URL missing or DB unavailable)');
  return pool.query(text, params);
}

module.exports = {
  initDb,
  query,
  pool,
};
