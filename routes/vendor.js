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
    // vendor_backends(vendor_id text unique, latitude numeric, longitude numeric, offer_url text, is_available bool, updated_at)
    const preferredRow = {
      vendor_id: String(incomingVendorId),
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      offer_url: offerUrlFinal,
      is_available: true,
      updated_at: now,
    };

    // Back-compat schema used by existing migrations:
    // vendor_backends(vendor_ref text unique, last_latitude numeric, last_longitude numeric, offer_url text, active bool, updated_at)
    const legacyRow = {
      vendor_ref: String(incomingVendorId),
      last_latitude: latitude ?? null,
      last_longitude: longitude ?? null,
      offer_url: offerUrlFinal,
      active: true,
      updated_at: now,
    };

    let data;
    let error;

    ({ data, error } = await supabase
      .from('vendor_backends')
      .upsert([preferredRow], { onConflict: 'vendor_id' })
      .select('*')
      .maybeSingle());

    if (error && /column .*vendor_id.*does not exist|on conflict.*vendor_id|there is no unique or exclusion constraint/i.test(error.message || '')) {
      ({ data, error } = await supabase
        .from('vendor_backends')
        .upsert([legacyRow], { onConflict: 'vendor_ref' })
        .select('*')
        .maybeSingle());
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

module.exports = router;

