const express = require('express');

const { createServiceClient } = require('../supabase/client');
const { ensureDevProfile, isDevBypassAllowed, pickOrCreateDevCustomerId } = require('../supabase/devBypass');

const router = express.Router();

function normalizePickupRow(p) {
  if (!p) return null;
  return {
    id: p.id,
    status: p.status,
    address: p.address,
    latitude: p.latitude,
    longitude: p.longitude,
    timeSlot: p.time_slot,
    assignedVendorRef: p.assigned_vendor_ref,
    assignmentExpiresAt: p.assignment_expires_at,
    cancelledAt: p.cancelled_at,
    createdAt: p.created_at,
    items: (p.pickup_items || []).map((it) => ({
      id: it.id,
      scrapTypeId: it.scrap_type_id,
      scrapTypeName: it.scrap_types?.name || null,
      estimatedQuantity: it.estimated_quantity,
    })),
  };
}

// GET /api/orders
// Dev-bypass: lists orders for a temporary customer id.
router.get('/', async (req, res) => {
  if (!isDevBypassAllowed()) {
    return res.status(403).json({
      success: false,
      error: 'Dev bypass is disabled on server. Set ALLOW_DEV_BYPASS=true to enable /api/orders.',
    });
  }

  try {
    let supabase;
    try {
      supabase = createServiceClient();
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    const devCustomerId = await pickOrCreateDevCustomerId(supabase);
    await ensureDevProfile(supabase, devCustomerId);

    const { data, error } = await supabase
      .from('pickups')
      .select(
        'id,status,address,latitude,longitude,time_slot,assigned_vendor_ref,assignment_expires_at,cancelled_at,created_at,' +
          'pickup_items(id,estimated_quantity,scrap_type_id,scrap_types(name))'
      )
      .eq('customer_id', devCustomerId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ success: false, error: error.message });

    const orders = (data || []).map(normalizePickupRow);
    return res.json({ success: true, count: orders.length, orders });
  } catch (e) {
    console.error('Error fetching orders (dev):', e);
    return res.status(500).json({ success: false, error: 'Could not fetch orders' });
  }
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  if (!isDevBypassAllowed()) {
    return res.status(403).json({
      success: false,
      error: 'Dev bypass is disabled on server. Set ALLOW_DEV_BYPASS=true to enable /api/orders/:id.',
    });
  }

  const orderId = String(req.params.id || '').trim();
  if (!orderId) return res.status(400).json({ success: false, error: 'id is required' });

  try {
    let supabase;
    try {
      supabase = createServiceClient();
    } catch (e) {
      return res.status(500).json({ success: false, error: e?.message || 'Supabase is not configured on server' });
    }

    const devCustomerId = await pickOrCreateDevCustomerId(supabase);
    await ensureDevProfile(supabase, devCustomerId);

    const { data, error } = await supabase
      .from('pickups')
      .select(
        'id,status,address,latitude,longitude,time_slot,assigned_vendor_ref,assignment_expires_at,cancelled_at,created_at,' +
          'pickup_items(id,estimated_quantity,scrap_type_id,scrap_types(name))'
      )
      .eq('id', orderId)
      .eq('customer_id', devCustomerId)
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'Order not found' });

    return res.json({ success: true, order: normalizePickupRow(data) });
  } catch (e) {
    console.error('Error fetching order (dev):', e);
    return res.status(500).json({ success: false, error: 'Could not fetch order' });
  }
});

module.exports = router;
