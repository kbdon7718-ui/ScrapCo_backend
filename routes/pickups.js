/**
 * backend/routes/pickups.js
 *
 * This file defines pickup-related API routes.
 *
 * Routes in this file will be mounted at:
 *   /api/pickups
 *
 * So inside this router:
 * - GET /      means GET /api/pickups
 * - POST /     means POST /api/pickups
 */

const express = require('express');

const { createAnonClientWithJwt, createServiceClient } = require('../supabase/client');
const { getBearerToken } = require('../supabase/auth');

const router = express.Router();

// Dispatch service: responsible for finding vendors and sending offers
const dispatcher = require('../services/dispatcher');

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  function toRad(v) {
    return (v * Math.PI) / 180;
  }
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchVendorInfoByRef(vendorRef) {
  if (!vendorRef) return null;

  let service;
  try {
    service = createServiceClient();
  } catch (e) {
    // Service role isn't strictly required for customer status polling.
    // If not configured, return no vendor enrichment.
    return null;
  }
  const ref = String(vendorRef);

  // Do NOT select explicit columns like name/phone because some Supabase schemas don't have them.
  // Instead select '*' and map known location fields for ETA.

  // Preferred schema (vendor_id, latitude, longitude)
  try {
    const { data, error } = await service.from('vendor_backends').select('*').eq('vendor_id', ref).maybeSingle();
    if (error && /column .*vendor_id.*does not exist/i.test(error.message || '')) {
      // fall through
    } else if (error) {
      console.warn('vendor_backends lookup failed', error.message || error);
      return null;
    } else if (data) {
      return {
        ref: data.vendor_id || ref,
        latitude: data.latitude != null ? Number(data.latitude) : null,
        longitude: data.longitude != null ? Number(data.longitude) : null,
        updatedAt: data.updated_at || null,
      };
    }
  } catch {
    // ignore
  }

  // Legacy schema (vendor_ref, last_latitude, last_longitude)
  try {
    const { data, error } = await service.from('vendor_backends').select('*').eq('vendor_ref', ref).maybeSingle();
    if (error) {
      console.warn('vendor_backends legacy lookup failed', error.message || error);
      return null;
    }
    if (!data) return null;
    return {
      ref: data.vendor_ref || ref,
      latitude: data.last_latitude != null ? Number(data.last_latitude) : null,
      longitude: data.last_longitude != null ? Number(data.last_longitude) : null,
      updatedAt: data.updated_at || null,
    };
  } catch {
    return null;
  }
}

/**
 * Helper: Validate the incoming request body.
 * We return an error message string if invalid, or null if valid.
 */
function validatePickupBody(body) {
  // Basic checks for required fields.
  if (!body) return 'Request body is missing.';

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return 'items is required (array of { scrapTypeId, estimatedQuantity }).';
  }

  if (!body.address || String(body.address).trim() === '') {
    return 'address is required.';
  }

  if (!body.timeSlot || String(body.timeSlot).trim() === '') {
    return 'timeSlot is required.';
  }

  // latitude/longitude are optional but if provided must be numbers
  if (body.latitude != null && typeof body.latitude !== 'number') return 'latitude must be a number.';
  if (body.longitude != null && typeof body.longitude !== 'number') return 'longitude must be a number.';

  return null;
}

/**
 * POST /api/pickups
 * Accepts JSON body, validates it, creates a pickup object, stores it, returns it.
 */
router.post('/', async (req, res) => {
  // req.body exists because we use express.json() middleware in index.js
  const errorMessage = validatePickupBody(req.body);

  if (errorMessage) {
    // 400 = Bad Request (client sent invalid data)
    return res.status(400).json({
      success: false,
      error: errorMessage,
    });
  }

  // Create pickup
  try {
    const jwt = getBearerToken(req);
    if (!jwt) return res.status(401).json({ success: false, error: 'Missing Authorization Bearer token' });

    let supabase;
    try {
      supabase = createAnonClientWithJwt(jwt);
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    // Recommended: use RPC so Postgres sets customer_id = auth.uid() and inserts items transactionally.
    const { data, error } = await supabase.rpc('create_pickup', {
      p_address: String(req.body.address).trim(),
      p_latitude: req.body.latitude ?? null,
      p_longitude: req.body.longitude ?? null,
      p_time_slot: String(req.body.timeSlot).trim(),
      p_items: req.body.items,
    });

    if (error) {
      const msg = error.message || 'Could not create pickup';
      // When the RPC doesn't exist yet, guide setup.
      if (/function create_pickup/i.test(msg) || /schema cache/i.test(msg)) {
        return res.status(501).json({
          success: false,
          error: 'Missing RPC create_pickup. Apply the Supabase SQL migration for RLS + RPC, then retry.',
        });
      }
      return res.status(400).json({ success: false, error: msg });
    }

    // RPC returns pickupId (uuid)
    const pickupId = data;

    console.log(`[DISPATCH] pickup_created pickupId=${pickupId}`);

    // Kick off dispatch in background (do not block response)
    try {
      if (pickupId) {
        dispatcher.dispatchPickup(pickupId).catch((e) => console.warn('[DISPATCH] dispatch_error', e));
      }
    } catch (e) {
      console.warn('[DISPATCH] dispatch_schedule_failed', e);
    }

    return res.status(201).json({ success: true, pickupId });
  } catch (err) {
    console.error('Error creating pickup:', err);
    return res.status(500).json({ success: false, error: 'Could not create pickup' });
  }
});

/**
 * GET /api/pickups/:id
 * Fetch a single pickup (status tracking)
 */
router.get('/:id', async (req, res) => {
  try {
    const jwt = getBearerToken(req);
    if (!jwt) return res.status(401).json({ success: false, error: 'Missing Authorization Bearer token' });

    let supabase;
    try {
      supabase = createAnonClientWithJwt(jwt);
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { data, error } = await supabase
      .from('pickups')
      .select(
        'id,status,address,latitude,longitude,time_slot,assigned_vendor_ref,assignment_expires_at,cancelled_at,completed_at,created_at,' +
          'pickup_items(id,estimated_quantity,scrap_type_id,scrap_types(name))'
      )
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'pickup not found' });

    const assignedVendorRef = data.assigned_vendor_ref || null;
    const vendor = assignedVendorRef ? await fetchVendorInfoByRef(assignedVendorRef) : null;

    let etaMinutes = null;
    try {
      const vLat = vendor?.latitude;
      const vLng = vendor?.longitude;
      const pLat = data.latitude;
      const pLng = data.longitude;
      if (
        Number.isFinite(Number(vLat)) &&
        Number.isFinite(Number(vLng)) &&
        Number.isFinite(Number(pLat)) &&
        Number.isFinite(Number(pLng))
      ) {
        // Simple ETA heuristic: assume ~20 km/h average in-city.
        const distKm = haversineDistanceKm(Number(vLat), Number(vLng), Number(pLat), Number(pLng));
        const minutes = (distKm / 20) * 60;
        const bounded = Math.max(5, Math.min(180, minutes));
        etaMinutes = Math.round(bounded);
      }
    } catch {
      etaMinutes = null;
    }

    return res.json({
      success: true,
      pickup: {
        id: data.id,
        status: data.status,
        address: data.address,
        latitude: data.latitude,
        longitude: data.longitude,
        timeSlot: data.time_slot,
        assignedVendorRef,
        assignmentExpiresAt: data.assignment_expires_at,
        cancelledAt: data.cancelled_at,
        completedAt: data.completed_at,
        createdAt: data.created_at,
        vendor: vendor ? { ref: vendor.ref, name: vendor.name, phone: vendor.phone, updatedAt: vendor.updatedAt } : null,
        etaMinutes,
        items: (data.pickup_items || []).map((it) => ({
          id: it.id,
          scrapTypeId: it.scrap_type_id,
          scrapTypeName: it.scrap_types?.name || null,
          estimatedQuantity: it.estimated_quantity,
        })),
      },
    });
  } catch (err) {
    console.error('Error fetching pickup:', err);
    return res.status(500).json({ success: false, error: 'Could not fetch pickup' });
  }
});

/**
 * POST /api/pickups/:id/find-vendor
 * Customer-initiated retry: clears any current offer and restarts dispatch.
 * Dispatch decisions remain in the backend.
 */
router.post('/:id/find-vendor', async (req, res) => {
  try {
    const jwt = getBearerToken(req);
    if (!jwt) return res.status(401).json({ success: false, error: 'Missing Authorization Bearer token' });

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const anon = createAnonClientWithJwt(jwt);
    const { data: owned, error: ownErr } = await anon.from('pickups').select('id,status').eq('id', id).maybeSingle();
    if (ownErr) return res.status(400).json({ success: false, error: ownErr.message || 'Could not verify pickup' });
    if (!owned) return res.status(404).json({ success: false, error: 'pickup not found' });

    const status = String(owned.status || '').toUpperCase();
    if (status === 'ASSIGNED' || status === 'ON_THE_WAY' || status === 'CANCELLED' || status === 'COMPLETED') {
      return res.status(409).json({ success: false, error: `Cannot retry vendor assignment for status ${owned.status}` });
    }

    // Prefer a security-definer RPC so this works without SUPABASE_SERVICE_ROLE_KEY.
    // Falls back to service-role update if RPC isn't present.
    try {
      const { error: rpcErr } = await anon.rpc('find_vendor_again', { p_pickup_id: id });
      if (rpcErr) throw rpcErr;
    } catch (e) {
      const msg = e?.message || String(e);
      if (/function find_vendor_again|schema cache/i.test(msg)) {
        const service = createServiceClient();
        await service
          .from('pickups')
          .update({
            status: 'FINDING_VENDOR',
            assigned_vendor_ref: null,
            assignment_expires_at: null,
            cancelled_at: null,
          })
          .eq('id', id);
      } else {
        return res.status(400).json({ success: false, error: msg || 'Could not restart vendor dispatch' });
      }
    }

    // Cancel any in-memory timers/state for this pickup before restarting.
    try {
      const state = dispatcher?._internal?.dispatchState?.get(id);
      if (state?.timer) clearTimeout(state.timer);
      dispatcher?._internal?.dispatchState?.delete(id);
    } catch {
      // ignore
    }

    dispatcher.dispatchPickup(id).catch((e) => console.warn('[DISPATCH] dispatch_error', e));
    return res.json({ success: true, pickupId: id, status: 'FINDING_VENDOR' });
  } catch (e) {
    console.error('find-vendor failed', e);
    return res.status(500).json({ success: false, error: 'Could not restart vendor dispatch' });
  }
});

/**
 * POST /api/pickups/:id/cancel
 * Soft-delete for customers: marks the pickup CANCELLED and clears any outstanding offer.
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const jwt = getBearerToken(req);
    if (!jwt) return res.status(401).json({ success: false, error: 'Missing Authorization Bearer token' });

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const anon = createAnonClientWithJwt(jwt);
    const { data: owned, error: ownErr } = await anon.from('pickups').select('id,status').eq('id', id).maybeSingle();
    if (ownErr) return res.status(400).json({ success: false, error: ownErr.message || 'Could not verify pickup' });
    if (!owned) return res.status(404).json({ success: false, error: 'pickup not found' });

    const status = String(owned.status || '').toUpperCase();
    if (status === 'COMPLETED') {
      return res.status(409).json({ success: false, error: 'Completed pickups cannot be cancelled' });
    }

    // Prefer a security-definer RPC so this works without SUPABASE_SERVICE_ROLE_KEY.
    // Falls back to service-role update if RPC isn't present.
    try {
      const { error: rpcErr } = await anon.rpc('cancel_pickup', { p_pickup_id: id });
      if (rpcErr) throw rpcErr;
    } catch (e) {
      const msg = e?.message || String(e);
      if (/function cancel_pickup|schema cache/i.test(msg)) {
        const service = createServiceClient();
        const now = new Date().toISOString();
        await service
          .from('pickups')
          .update({
            status: 'CANCELLED',
            cancelled_at: now,
            assigned_vendor_ref: null,
            assignment_expires_at: null,
          })
          .eq('id', id);
      } else {
        return res.status(400).json({ success: false, error: msg || 'Could not cancel pickup' });
      }
    }

    // Stop any in-memory timers/state for this pickup.
    try {
      const state = dispatcher?._internal?.dispatchState?.get(id);
      if (state?.timer) clearTimeout(state.timer);
      dispatcher?._internal?.dispatchState?.delete(id);
    } catch {
      // ignore
    }

    return res.json({ success: true, pickupId: id, status: 'CANCELLED' });
  } catch (e) {
    console.error('cancel pickup failed', e);
    return res.status(500).json({ success: false, error: 'Could not cancel pickup' });
  }
});

/**
 * POST /api/pickups/accepted
 * Optional vendor notification endpoint: vendor can POST here to notify the customer backend
 * that it has accepted and notified its user. This will attempt to confirm acceptance via dispatcher.
 */
router.post('/accepted', async (req, res) => {
  // vendor should sign this request using same signature scheme
  const { verifyVendorSignature } = require('../vendor/security');
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const body = req.body || {};
  const pickupId = body.pickupId || body.pickup_id || body.request_id || body.requestId;
  const { assignedVendorRef } = body;
  if (!pickupId) {
    return res.status(400).json({
      success: false,
      error: 'pickupId is required (accepted keys: pickupId, pickup_id, request_id, requestId)',
    });
  }

  try {
    const dispatcher = require('../services/dispatcher');
    const result = await dispatcher.confirmVendorAcceptance(pickupId, assignedVendorRef);
    if (!result) return res.status(409).json({ success: false, error: 'Could not confirm acceptance' });
    return res.json({ success: true, pickup: result });
  } catch (e) {
    console.error('Pickup accepted notify failed', e);
    return res.status(500).json({ success: false, error: 'Pickup accepted notify failed' });
  }
});

// After create we attempt dispatching (non-blocking)
// Note: the RPC above returns the `pickup` row; callers that use this
// route will receive the created pickup immediately while dispatch runs
// in the background.

module.exports = router;
