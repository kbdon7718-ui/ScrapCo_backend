/**
 * backend/data/store.js
 *
 * This file is our TEMPORARY in-memory "database".
 *
 * IMPORTANT:
 * - Data is stored in RAM (memory).
 * - If you stop/restart the server, ALL pickups are lost.
 * - This is perfect for learning and MVP testing.
 */

// Fallback in-memory store
const pickups = [];
let nextPickupId = 1;

// Attempt to use Postgres if configured
let db = null;
try {
  db = require('../db/client');
} catch (err) {
  db = null;
}

/**
 * Create a new pickup request and store it.
 * If DATABASE_URL is configured, store in Postgres (pickups + pickup_items), otherwise in-memory.
 *
 * Expected input shape:
 * {
 *   user: <phone string> (optional),
 *   scrapTypes: [ 'Paper', 'Metal' ] OR [ { name, estimated_quantity } ],
 *   quantity: <number> (optional, applied when scrapTypes is string array),
 *   address, timeSlot, location: { latitude, longitude }
 * }
 */
async function createPickup(input) {
  if (db && db.pool) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Find or create profile by phone when provided
      let customerId = null;
      if (input.user) {
        const found = await client.query('SELECT id FROM profiles WHERE phone = $1 LIMIT 1', [input.user]);
        if (found.rows.length) {
          customerId = found.rows[0].id;
        } else {
          const ins = await client.query('INSERT INTO profiles (phone, role) VALUES ($1, $2) RETURNING id', [input.user, 'customer']);
          customerId = ins.rows[0].id;
        }
      } else {
        // anonymous customer record
        const ins = await client.query("INSERT INTO profiles (role) VALUES ($1) RETURNING id", ['customer']);
        customerId = ins.rows[0].id;
      }

      const pickupRes = await client.query(
        `INSERT INTO pickups (customer_id, assigned_vendor_ref, assignment_expires_at, status, address, latitude, longitude, time_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, status, created_at, address, latitude, longitude, time_slot`,
        [customerId, null, null, 'REQUESTED', input.address || '', input.location?.latitude || null, input.location?.longitude || null, input.timeSlot || 'Anytime']
      );

      const pickupId = pickupRes.rows[0].id;

      const items = input.scrapTypes || [];
      for (const it of items) {
        let name; let qty;
        if (typeof it === 'string') { name = it; qty = input.quantity || 0; }
        else { name = it.name; qty = it.estimated_quantity || it.quantity || 0; }

        // ensure scrap_type exists
        const st = await client.query('SELECT id FROM scrap_types WHERE name = $1 LIMIT 1', [name]);
        let scrapTypeId;
        if (st.rows.length) scrapTypeId = st.rows[0].id;
        else {
          const insst = await client.query('INSERT INTO scrap_types (name) VALUES ($1) RETURNING id', [name]);
          scrapTypeId = insst.rows[0].id;
        }

        await client.query('INSERT INTO pickup_items (pickup_id, scrap_type_id, estimated_quantity) VALUES ($1,$2,$3)', [pickupId, scrapTypeId, qty]);
      }

      await client.query('COMMIT');

      // Return pickup with items
      const out = await db.query('SELECT id, address, time_slot AS "timeSlot", status, created_at AS "createdAt", latitude, longitude FROM pickups WHERE id = $1', [pickupId]);
      const itemsOut = await db.query('SELECT pi.id, st.name AS "scrapType", pi.estimated_quantity FROM pickup_items pi JOIN scrap_types st ON pi.scrap_type_id = st.id WHERE pi.pickup_id = $1', [pickupId]);

      const row = out.rows[0];
      return {
        id: row.id,
        address: row.address,
        timeSlot: row.timeSlot,
        location: { latitude: row.latitude, longitude: row.longitude },
        status: row.status,
        createdAt: row.createdAt,
        items: itemsOut.rows.map(r => ({ id: r.id, scrapType: r.scrapType, estimatedQuantity: r.estimated_quantity }))
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // In-memory fallback (keeps previous single-item shape)
  const pickup = {
    id: nextPickupId,
    scrapType: (input.scrapTypes && input.scrapTypes.length) ? (typeof input.scrapTypes[0] === 'string' ? input.scrapTypes[0] : input.scrapTypes[0].name) : input.scrapType,
    address: input.address,
    timeSlot: input.timeSlot,
    location: { latitude: input.location?.latitude || null, longitude: input.location?.longitude || null },
    status: 'REQUESTED',
    createdAt: new Date().toISOString(),
  };

  pickups.push(pickup);
  nextPickupId += 1;
  return pickup;
}

/**
 * Get all pickup requests.
 * Returns from Postgres if configured, otherwise from memory.
 */
async function getAllPickups() {
  if (db && db.query) {
    const sql = `SELECT p.id, p.address, p.time_slot AS "timeSlot", p.latitude, p.longitude, p.status, p.created_at AS "createdAt",
      json_agg(json_build_object('id', pi.id, 'scrapType', st.name, 'estimatedQuantity', pi.estimated_quantity)) FILTER (WHERE pi.id IS NOT NULL) AS items
      FROM pickups p
      LEFT JOIN pickup_items pi ON pi.pickup_id = p.id
      LEFT JOIN scrap_types st ON pi.scrap_type_id = st.id
      GROUP BY p.id
      ORDER BY p.created_at DESC`;
    const result = await db.query(sql);
    return result.rows.map((r) => ({
      id: r.id,
      address: r.address,
      timeSlot: r.timeSlot,
      location: { latitude: r.latitude, longitude: r.longitude },
      status: r.status,
      createdAt: r.createdAt,
      items: r.items || [],
    }));
  }

  return pickups;
}

module.exports = {
  createPickup,
  getAllPickups,
};
