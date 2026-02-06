const express = require('express');

const { verifyVendorSignature } = require('../vendor/security');
const { createServiceClient } = require('../supabase/client');
const dispatcher = require('../services/dispatcher');

const router = express.Router();

// POST /api/vendor/accept
// Vendor backend calls this to accept a pickup.
// Protected by HMAC signature of the raw request body.
router.post('/accept', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const body = req.body || {};
  const pickupId = body.pickupId || body.pickup_id || body.request_id || body.requestId;
  const { assignedVendorRef, vendor_id, vendorId } = body;
  if (!pickupId) {
    return res.status(400).json({
      success: false,
      error: 'pickupId is required (accepted keys: pickupId, pickup_id, request_id, requestId)',
    });
  }

  const vendorRef = assignedVendorRef || vendor_id || vendorId;
  if (!vendorRef) return res.status(400).json({ success: false, error: 'vendor_id (or assignedVendorRef) is required' });

  try {
    // Confirm acceptance through dispatcher which enforces assignment matching and state transitions
    const result = await dispatcher.confirmVendorAcceptance(pickupId, vendorRef);
    if (!result) {
      return res.status(409).json({ success: false, error: 'Pickup not found, not assigned to this vendor, or already assigned' });
    }

    return res.json({ success: true, pickup: result });
  } catch (e) {
    console.error('Vendor accept failed', e);
    return res.status(500).json({ success: false, error: 'Vendor accept failed' });
  }
});

// POST /api/vendor/location
// Vendor backend posts its latest location and endpoint info.
// NOTE: This endpoint is intentionally unauthenticated for now (write-only presence updates).
router.post('/location', async (req, res) => {
  const { vendor_id, vendorId, vendorRef, latitude, longitude, offer_url, offerUrl } = req.body || {};
  const incomingVendorId = vendor_id || vendorId || vendorRef;

  if (!incomingVendorId) return res.status(400).json({ success: false, error: 'vendor_id is required' });
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ success: false, error: 'latitude and longitude must be numbers' });
  }

  try {
    const supabase = createServiceClient();

    const now = new Date().toISOString();
    const offerUrlFinal = offer_url || offerUrl || null;

    // Preferred schema:
    // vendor_backends(vendor_id text unique, latitude numeric, longitude numeric, offer_url text, updated_at)
    let preferredRow = {
      vendor_id: String(incomingVendorId),
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      offer_url: offerUrlFinal,
      updated_at: now,
    };

    // Back-compat schema used by existing migrations:
    // vendor_backends(vendor_ref text unique, last_latitude numeric, last_longitude numeric, offer_url text, updated_at)
    let legacyRow = {
      vendor_ref: String(incomingVendorId),
      last_latitude: latitude ?? null,
      last_longitude: longitude ?? null,
      offer_url: offerUrlFinal,
      updated_at: now,
    };

    let data;
    let error;

    ({ data, error } = await supabase.from('vendor_backends').upsert([preferredRow], { onConflict: 'vendor_id' }).select('*').maybeSingle());

    if (error && /column .*vendor_id.*does not exist|on conflict.*vendor_id|there is no unique or exclusion constraint/i.test(error.message || '')) {
      ({ data, error } = await supabase.from('vendor_backends').upsert([legacyRow], { onConflict: 'vendor_ref' }).select('*').maybeSingle());
    }

    if (error) {
      console.warn('vendor location upsert error', error.message || error);
      return res.status(400).json({ success: false, error: error.message || 'Could not upsert vendor location' });
    }

    // Write-only presence: return minimal confirmation.
    return res.json({ success: true, vendor_id: String(incomingVendorId), updated_at: data?.updated_at || now });
  } catch (e) {
    console.error('Vendor location failed', e);
    return res.status(500).json({ success: false, error: 'Vendor location failed' });
  }
});

// POST /api/vendor/reject
// Vendor backend calls this to reject an offered pickup.
router.post('/reject', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const body = req.body || {};
  const pickupId = body.pickupId || body.pickup_id || body.request_id || body.requestId;
  const { assignedVendorRef, vendor_id, vendorId } = body;
  if (!pickupId) {
    return res.status(400).json({
      success: false,
      error: 'pickupId is required (accepted keys: pickupId, pickup_id, request_id, requestId)',
    });
  }

  const vendorRef = assignedVendorRef || vendor_id || vendorId;
  if (!vendorRef) return res.status(400).json({ success: false, error: 'vendor_id (or assignedVendorRef) is required' });

  try {
    const result = await dispatcher.handleVendorRejection(pickupId, vendorRef);
    return res.json({ success: true, result: result || { ignored: true } });
  } catch (e) {
    console.error('Vendor reject failed', e);
    return res.status(500).json({ success: false, error: 'Vendor reject failed' });
  }
});

// POST /api/vendor/on-the-way
// Vendor backend calls this when it is en route to the customer.
router.post('/on-the-way', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const body = req.body || {};
  const pickupId = body.pickupId || body.pickup_id || body.request_id || body.requestId;
  const { assignedVendorRef, vendor_id, vendorId } = body;

  if (!pickupId) {
    return res.status(400).json({
      success: false,
      error: 'pickupId is required (accepted keys: pickupId, pickup_id, request_id, requestId)',
    });
  }

  const vendorRef = assignedVendorRef || vendor_id || vendorId;
  if (!vendorRef) return res.status(400).json({ success: false, error: 'vendor_id (or assignedVendorRef) is required' });

  try {
    const supabase = createServiceClient();
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('pickups')
      .update({ status: 'ON_THE_WAY' })
      .eq('id', String(pickupId))
      .eq('assigned_vendor_ref', String(vendorRef))
      .in('status', ['ASSIGNED', 'ON_THE_WAY'])
      .select('id,status,assigned_vendor_ref,completed_at,cancelled_at,created_at')
      .maybeSingle();

    if (error) {
      const msg = error.message || 'Could not set ON_THE_WAY';
      // If the DB enum wasn't migrated yet, any mention of ON_THE_WAY will hard-error.
      if (/invalid input value for enum\s+pickup_status:\s+"ON_THE_WAY"/i.test(msg)) {
        return res.status(501).json({
          success: false,
          error:
            'ON_THE_WAY is not enabled in DB yet. Apply Supabase migration backend/supabase/migrations/003_pickup_status_and_rpcs.sql then retry.',
        });
      }
      return res.status(400).json({ success: false, error: msg });
    }
    if (!data) {
      return res.status(409).json({
        success: false,
        error: 'Pickup not found, not assigned to this vendor, or not in a state that can be set to ON_THE_WAY',
      });
    }

    return res.json({ success: true, pickup: { ...data, updated_at: now } });
  } catch (e) {
    console.error('Vendor on-the-way failed', e);
    return res.status(500).json({ success: false, error: 'Vendor on-the-way failed' });
  }
});

// POST /api/vendor/pickup-done
// Vendor backend calls this when pickup is completed.
router.post('/pickup-done', async (req, res) => {
  const sig = verifyVendorSignature(req);
  if (!sig.ok) return res.status(401).json({ success: false, error: sig.error });

  const body = req.body || {};
  const pickupId = body.pickupId || body.pickup_id || body.request_id || body.requestId;
  const { assignedVendorRef, vendor_id, vendorId } = body;

  if (!pickupId) {
    return res.status(400).json({
      success: false,
      error: 'pickupId is required (accepted keys: pickupId, pickup_id, request_id, requestId)',
    });
  }

  const vendorRef = assignedVendorRef || vendor_id || vendorId;
  if (!vendorRef) return res.status(400).json({ success: false, error: 'vendor_id (or assignedVendorRef) is required' });

  try {
    const supabase = createServiceClient();
    const now = new Date().toISOString();

    // First try allowing completion from ASSIGNED or ON_THE_WAY.
    // If the DB enum doesn't have ON_THE_WAY yet, retry with ASSIGNED only.
    let data;
    let error;

    ({ data, error } = await supabase
      .from('pickups')
      .update({ status: 'COMPLETED', completed_at: now })
      .eq('id', String(pickupId))
      .eq('assigned_vendor_ref', String(vendorRef))
      .in('status', ['ASSIGNED', 'ON_THE_WAY'])
      .select('id,status,assigned_vendor_ref,completed_at,cancelled_at,created_at')
      .maybeSingle());

    if (error && /invalid input value for enum\s+pickup_status:\s+"ON_THE_WAY"/i.test(error.message || '')) {
      ({ data, error } = await supabase
        .from('pickups')
        .update({ status: 'COMPLETED', completed_at: now })
        .eq('id', String(pickupId))
        .eq('assigned_vendor_ref', String(vendorRef))
        .eq('status', 'ASSIGNED')
        .select('id,status,assigned_vendor_ref,completed_at,cancelled_at,created_at')
        .maybeSingle());
    }

    if (error) return res.status(400).json({ success: false, error: error.message || 'Could not set COMPLETED' });
    if (!data) {
      return res.status(409).json({
        success: false,
        error: 'Pickup not found, not assigned to this vendor, or not in a state that can be completed',
      });
    }

    // Stop any in-memory dispatch timers/state for this pickup.
    try {
      const state = dispatcher?._internal?.dispatchState?.get(String(pickupId));
      if (state?.timer) clearTimeout(state.timer);
      dispatcher?._internal?.dispatchState?.delete(String(pickupId));
    } catch {
      // ignore
    }

    return res.json({ success: true, pickup: data });
  } catch (e) {
    console.error('Vendor pickup-done failed', e);
    return res.status(500).json({ success: false, error: 'Vendor pickup-done failed' });
  }
});

module.exports = router;

