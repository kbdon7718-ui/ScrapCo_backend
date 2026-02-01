const express = require('express');
const { createPublicAnonClient } = require('../supabase/client');

const router = express.Router();

const DEFAULT_TYPES = [
  { name: 'Plastic', ratePerKg: 11 },
  { name: 'Cardboard', ratePerKg: 12 },
  { name: 'Metal', ratePerKg: 25 },
  { name: 'Paper', ratePerKg: 8 },
];

// GET /api/scrap-types
// Returns list of scrap types with the current active rate (if any)
router.get('/', async (req, res) => {
  try {
    let supabase;
    try {
      supabase = createPublicAnonClient();
    } catch (e) {
      // If Supabase env vars are not configured, keep the UI usable.
      return res.json({ success: true, count: DEFAULT_TYPES.length, types: DEFAULT_TYPES });
    }

    const { data: types, error: typesErr } = await supabase
      .from('scrap_types')
      .select('id,name,description,created_at')
      .order('name', { ascending: true });

    if (typesErr) {
      console.warn('scrap_types query failed; returning defaults:', typesErr.message);
      return res.json({ success: true, count: DEFAULT_TYPES.length, types: DEFAULT_TYPES });
    }

    const { data: rates, error: ratesErr } = await supabase
      .from('scrap_rates')
      .select('scrap_type_id,rate_per_kg,effective_from,is_active')
      .eq('is_active', true);

    if (ratesErr) {
      console.warn('scrap_rates query failed; returning defaults:', ratesErr.message);
      return res.json({ success: true, count: DEFAULT_TYPES.length, types: DEFAULT_TYPES });
    }

    const latestRateByType = new Map();
    for (const r of rates || []) {
      const prev = latestRateByType.get(r.scrap_type_id);
      if (!prev) {
        latestRateByType.set(r.scrap_type_id, r);
        continue;
      }
      // pick latest effective_from
      const prevDate = prev.effective_from ? new Date(prev.effective_from) : new Date(0);
      const nextDate = r.effective_from ? new Date(r.effective_from) : new Date(0);
      if (nextDate >= prevDate) latestRateByType.set(r.scrap_type_id, r);
    }

    const out = (types || []).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      ratePerKg: latestRateByType.get(t.id)?.rate_per_kg ?? null,
    }));

    if (!out.length) {
      return res.json({ success: true, count: DEFAULT_TYPES.length, types: DEFAULT_TYPES });
    }

    return res.json({ success: true, count: out.length, types: out });
  } catch (err) {
    console.error('Failed to fetch scrap types', err);
    return res.status(500).json({ success: false, error: 'Could not fetch scrap types' });
  }
});

module.exports = router;
