const express = require('express');

const { createServiceClient } = require('../supabase/client');

const router = express.Router();

function isAdminPortalAllowed() {
  // No user auth, but keep an environment switch to avoid accidental exposure.
  const allowAdmin = String(process.env.ALLOW_ADMIN_PORTAL || '').toLowerCase() === 'true';
  const allowDev = String(process.env.ALLOW_DEV_BYPASS || '').toLowerCase() === 'true';
  return allowAdmin || allowDev;
}

function requireAdminEnabled(req, res) {
  if (isAdminPortalAllowed()) return true;
  res.status(403).json({
    success: false,
    error: 'Admin portal is disabled on server. Set ALLOW_ADMIN_PORTAL=true (or ALLOW_DEV_BYPASS=true) in backend/.env.',
  });
  return false;
}

async function getActiveRateByType(supabase) {
  const { data, error } = await supabase
    .from('scrap_rates')
    .select('scrap_type_id,rate_per_kg,effective_from,is_active')
    .eq('is_active', true);

  if (error) throw error;

  const latest = new Map();
  for (const r of data || []) {
    const prev = latest.get(r.scrap_type_id);
    if (!prev) {
      latest.set(r.scrap_type_id, r);
      continue;
    }
    const prevDate = prev.effective_from ? new Date(prev.effective_from) : new Date(0);
    const nextDate = r.effective_from ? new Date(r.effective_from) : new Date(0);
    if (nextDate >= prevDate) latest.set(r.scrap_type_id, r);
  }
  return latest;
}

// GET /api/admin/scrap-types
// Returns types plus current active rate if present.
router.get('/scrap-types', async (req, res) => {
  if (!requireAdminEnabled(req, res)) return;

  try {
    const supabase = createServiceClient();

    const { data: types, error: typesErr } = await supabase
      .from('scrap_types')
      .select('id,name')
      .order('name', { ascending: true });
    if (typesErr) return res.status(400).json({ success: false, error: typesErr.message });

    const rates = await getActiveRateByType(supabase);

    const rows = (types || []).map((t) => {
      const r = rates.get(t.id);
      return {
        id: t.id,
        name: t.name,
        ratePerKg: r?.rate_per_kg ?? null,
        effectiveFrom: r?.effective_from ?? null,
      };
    });

    return res.json({ success: true, scrapTypes: rows });
  } catch (e) {
    console.error('Admin scrap-types failed', e);
    return res.status(500).json({ success: false, error: e?.message || 'Admin request failed' });
  }
});

// POST /api/admin/scrap-types
router.post('/scrap-types', async (req, res) => {
  if (!requireAdminEnabled(req, res)) return;

  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('scrap_types')
      .insert([{ name }])
      .select('id,name')
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });
    return res.status(201).json({ success: true, scrapType: data });
  } catch (e) {
    console.error('Admin create scrap-type failed', e);
    return res.status(500).json({ success: false, error: e?.message || 'Admin request failed' });
  }
});

// PATCH /api/admin/scrap-types/:id
router.patch('/scrap-types/:id', async (req, res) => {
  if (!requireAdminEnabled(req, res)) return;

  const id = String(req.params.id || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!id) return res.status(400).json({ success: false, error: 'id is required' });
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('scrap_types')
      .update({ name })
      .eq('id', id)
      .select('id,name')
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'scrap type not found' });

    return res.json({ success: true, scrapType: data });
  } catch (e) {
    console.error('Admin update scrap-type failed', e);
    return res.status(500).json({ success: false, error: e?.message || 'Admin request failed' });
  }
});

// POST /api/admin/scrap-rates
// Body: { scrapTypeId, ratePerKg }
router.post('/scrap-rates', async (req, res) => {
  if (!requireAdminEnabled(req, res)) return;

  const scrapTypeId = String(req.body?.scrapTypeId || '').trim();
  const ratePerKg = Number(req.body?.ratePerKg);

  if (!scrapTypeId) return res.status(400).json({ success: false, error: 'scrapTypeId is required' });
  if (!Number.isFinite(ratePerKg) || ratePerKg <= 0) {
    return res.status(400).json({ success: false, error: 'ratePerKg must be a positive number' });
  }

  try {
    const supabase = createServiceClient();

    // Deactivate previous active rates for this type.
    const { error: deactErr } = await supabase
      .from('scrap_rates')
      .update({ is_active: false })
      .eq('scrap_type_id', scrapTypeId)
      .eq('is_active', true);
    if (deactErr) return res.status(400).json({ success: false, error: deactErr.message });

    const row = {
      scrap_type_id: scrapTypeId,
      rate_per_kg: ratePerKg,
      is_active: true,
      effective_from: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('scrap_rates').insert([row]).select('*').single();
    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(201).json({
      success: true,
      rate: {
        scrapTypeId: data.scrap_type_id,
        ratePerKg: data.rate_per_kg,
        effectiveFrom: data.effective_from,
      },
    });
  } catch (e) {
    console.error('Admin set rate failed', e);
    return res.status(500).json({ success: false, error: e?.message || 'Admin request failed' });
  }
});

module.exports = router;
