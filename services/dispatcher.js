const fetch = require('node-fetch');
const { createServiceClient } = require('../supabase/client');

// In-memory dispatch state (timers, candidate lists)
const dispatchState = new Map();

let sweeperTimer = null;

function statusFindingVendor() { return 'FINDING_VENDOR'; }
function statusAssigned() { return 'ASSIGNED'; }
function statusNoVendorAvailable() { return 'NO_VENDOR_AVAILABLE'; }
function statusCancelled() { return 'CANCELLED'; }
function statusCompleted() { return 'COMPLETED'; }

function isTerminalStatus(status) {
  return status === statusAssigned() || status === statusCancelled() || status === statusCompleted();
}

function vendorIdOf(v) {
  return v?.vendor_id || v?.vendor_ref || v?.id || 'unknown';
}

function isVendorAvailable(v) {
  if (typeof v?.is_available === 'boolean') return v.is_available;
  if (typeof v?.active === 'boolean') return v.active;
  return true;
}

function offerUrlOf(v) {
  const raw = v?.offer_url || v?.endpoint || v?.endpoint_offer_url || null;
  if (!raw) return null;

  // Vendor Backend expects offers at POST /api/offer (SSE fanout happens there).
  // If the stored URL is already the full offer endpoint, keep it.
  // Otherwise, treat it as a base URL and force the /api/offer path.
  try {
    const u = new URL(raw);
    const normalizedPath = String(u.pathname || '').replace(/\/+$/, '');
    if (normalizedPath === '/api/offer') return u.toString();
    u.pathname = '/api/offer';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    // Fall back to raw (validation will likely reject it if malformed)
    return raw;
  }
}

async function fetchScrapSummary(supabase, pickupId) {
  // Optional enrichment: build a human-readable summary for the vendor UI.
  try {
    const { data, error } = await supabase
      .from('pickups')
      .select('id,pickup_items(estimated_quantity,scrap_type_id,scrap_types(name))')
      .eq('id', pickupId)
      .maybeSingle();

    if (error || !data) return null;
    const items = data.pickup_items || [];
    if (!Array.isArray(items) || items.length === 0) return null;

    const parts = items
      .map((it) => {
        const name = it?.scrap_types?.name || it?.scrap_type_id || 'Unknown';
        const qty = it?.estimated_quantity;
        if (qty == null || qty === '') return String(name);
        return `${name}: ${qty}`;
      })
      .filter(Boolean);

    return parts.length ? parts.join(', ') : null;
  } catch {
    return null;
  }
}

function validateOfferUrl(url) {
  if (!url) return { ok: false, reason: 'missing' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: 'not_http' };
  const host = (parsed.hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { ok: false, reason: 'localhost' };
  return { ok: true, reason: null };
}

function nowIso() {
  return new Date().toISOString();
}

function plusMinutesIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function fetchRejectedVendorRefs(supabase, pickupId) {
  // Optional persistence: if the table doesn't exist yet, treat as none.
  try {
    const { data, error } = await supabase
      .from('pickup_vendor_rejections')
      .select('vendor_ref')
      .eq('pickup_id', pickupId)
      .limit(500);

    if (error) {
      if (/relation .*pickup_vendor_rejections.* does not exist/i.test(error.message || '')) return new Set();
      console.warn('[DISPATCH] rejected_vendor_query_failed', error.message || error);
      return new Set();
    }

    return new Set((data || []).map((r) => String(r.vendor_ref)));
  } catch (e) {
    return new Set();
  }
}

async function recordVendorRejection(supabase, pickupId, vendorRef) {
  // Best-effort persistence: if the table doesn't exist yet, do not fail the request.
  try {
    const { error } = await supabase
      .from('pickup_vendor_rejections')
      .upsert([{ pickup_id: pickupId, vendor_ref: String(vendorRef), rejected_at: nowIso() }], {
        onConflict: 'pickup_id,vendor_ref',
      });

    if (error && !/relation .*pickup_vendor_rejections.* does not exist/i.test(error.message || '')) {
      console.warn('[DISPATCH] rejected_vendor_record_failed', error.message || error);
    }
  } catch {
    // ignore
  }
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  function toRad(v) { return (v * Math.PI) / 180; }
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchPickup(supabase, pickupId) {
  const { data, error } = await supabase.from('pickups').select('*').eq('id', pickupId).maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchVendors(supabase) {
  // Expected vendor_backends table (customer DB):
  // vendor_id, latitude, longitude, offer_url, is_available, updated_at
  // (Older variants may use active/vendor_ref/last_latitude/last_longitude)
  console.log('[DISPATCH] vendor_backends_query start');

  let data;
  let error;

  // Prefer current schema
  ({ data, error } = await supabase.from('vendor_backends').select('*').eq('is_available', true));

  // Back-compat for older schema that uses `active`
  if (error && /column .*is_available.*does not exist/i.test(error.message || '')) {
    console.warn('[DISPATCH] vendor_backends_query falling back to active=true (is_available column missing)');
    ({ data, error } = await supabase.from('vendor_backends').select('*').eq('active', true));
  }

  if (error) {
    console.warn('[DISPATCH] vendor_backends_query failed:', error.message || error);
    return [];
  }

  const list = (data || []).filter((v) => isVendorAvailable(v));
  console.log(`[DISPATCH] vendor_backends_query ok count=${list.length}`);
  return list;
}

async function sendOfferToVendor(supabase, vendor, pickup) {
  const url = offerUrlOf(vendor);
  const vendorId = vendorIdOf(vendor);

  const urlCheck = validateOfferUrl(url);
  if (!urlCheck.ok) {
  // Allow localhost during local development
  if (process.env.NODE_ENV !== 'production' && String(url).includes('localhost')) {
    console.warn(
      `[DISPATCH] offer_url_localhost_allowed pickupId=${pickup.id} vendor_id=${vendorId} offer_url=${String(url)}`
    );
  } else {
    console.warn(
      `[DISPATCH] offer_url_invalid pickupId=${pickup.id} vendor_id=${vendorId} offer_url=${String(url)} reason=${urlCheck.reason}`
    );
    throw new Error(`Invalid offer_url for vendor ${vendorId}: ${urlCheck.reason}`);
  }
}


  console.log(`[DISPATCH] offer_url_used pickupId=${pickup.id} vendor_id=${vendorId} offer_url=${url}`);

  const requestId = String(pickup.id);

  const latitude = Number(pickup.latitude ?? pickup.lat ?? null);
  const longitude = Number(pickup.longitude ?? pickup.lon ?? pickup.lng ?? null);

  const scrapSummary = await fetchScrapSummary(supabase, pickup.id);

  const body = {
    // Vendor backend SSE system expects these exact fields
    vendor_id: vendorId,
    request_id: requestId,
    // Back-compat / convenience: some vendor clients expect pickupId
    pickupId: requestId,
    pickup_id: requestId,

    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,

    ...(scrapSummary ? { scrap_summary: scrapSummary } : {}),
  };

  console.log(
    `[DISPATCH] offer_payload pickupId=${pickup.id} vendor_id=${vendorId} request_id=${requestId} lat=${body.latitude} lon=${body.longitude} scrap=${scrapSummary ? 'yes' : 'no'}`
  );

  const headers = { 'content-type': 'application/json' };
  if (process.env.VENDOR_API_TOKEN) headers['authorization'] = `Bearer ${process.env.VENDOR_API_TOKEN}`;

  const payload = JSON.stringify(body);
  console.log(`[DISPATCH] http_request_sent pickupId=${pickup.id} vendor_id=${vendorId} method=POST timeoutMs=10000 bytes=${Buffer.byteLength(payload)} url=${url}`);

  const started = Date.now();
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: payload, timeout: 10000 });
  } catch (e) {
    const elapsedMs = Date.now() - started;
    console.warn(
      `[DISPATCH] http_error pickupId=${pickup.id} vendor_id=${vendorId} elapsedMs=${elapsedMs} error=${e?.message || String(e)}`
    );
    throw e;
  }

  const elapsedMs = Date.now() - started;
  console.log(`[DISPATCH] http_response pickupId=${pickup.id} vendor_id=${vendorId} status=${resp.status} ok=${resp.ok} elapsedMs=${elapsedMs}`);

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    const snippet = String(txt || '').slice(0, 800);
    console.warn(`[DISPATCH] http_failure pickupId=${pickup.id} vendor_id=${vendorId} status=${resp.status} body=${snippet}`);
    throw new Error(`Vendor responded ${resp.status}: ${snippet}`);
  }

  console.log(`[DISPATCH] offer_sent pickupId=${pickup.id} vendor_id=${vendorId} offer_url=${url}`);
  return true;
}

async function dispatchPickup(pickupId, options = {}) {
  const supabase = createServiceClient();

  console.log(`[DISPATCH] dispatch_start pickupId=${pickupId}`);

  // Load pickup
  const pickup = await fetchPickup(supabase, pickupId);
  if (!pickup) {
    console.warn(`[DISPATCH] pickup_not_found pickupId=${pickupId}`);
    return;
  }

  // Do not attempt dispatch for terminal statuses
  if (isTerminalStatus(pickup.status)) {
    console.log(`[DISPATCH] dispatch_ignored_terminal pickupId=${pickupId} status=${pickup.status}`);
    return;
  }

  // If an active (unexpired) offer is already out, avoid restarting dispatch.
  if (
    pickup.status === statusFindingVendor() &&
    pickup.assigned_vendor_ref &&
    pickup.assignment_expires_at &&
    new Date(pickup.assignment_expires_at) > new Date()
  ) {
    console.log(
      `[DISPATCH] dispatch_ignored_active_offer pickupId=${pickupId} vendor_ref=${pickup.assigned_vendor_ref} expiresAt=${pickup.assignment_expires_at}`
    );
    return;
  }

  // Set status to FINDING_VENDOR (but never clobber terminal states)
  await supabase
    .from('pickups')
    .update({ status: statusFindingVendor() })
    .eq('id', pickupId)
    .in('status', ['REQUESTED', statusNoVendorAvailable(), statusFindingVendor()]);
  console.log(`[DISPATCH] status_change pickupId=${pickupId} status=${statusFindingVendor()}`);

  const vendors = await fetchVendors(supabase);
  if (!vendors || vendors.length === 0) {
    console.log(`[DISPATCH] no_vendors_available pickupId=${pickupId}`);
    await supabase.from('pickups').update({ status: statusNoVendorAvailable() }).eq('id', pickupId);
    return;
  }

  console.log(`[DISPATCH] vendors_loaded pickupId=${pickupId} count=${vendors.length}`);

  const skipRefs = new Set((options.skipVendorRefs || []).map((x) => String(x)));
  const persistedRejected = await fetchRejectedVendorRefs(supabase, pickupId);
  for (const ref of persistedRejected) skipRefs.add(String(ref));

  // Compute distances
  const px = Number(pickup.latitude) || Number(pickup.lat) || null;
  const py = Number(pickup.longitude) || Number(pickup.lon) || Number(pickup.lng) || null;

  const ranked = vendors
    .map((v) => {
      const vx = Number(v.last_latitude || v.latitude || v.lat || 0);
      const vy = Number(v.last_longitude || v.longitude || v.lon || v.lng || 0);
      const dist = px != null && py != null ? haversineDistanceKm(px, py, vx, vy) : Number.MAX_SAFE_INTEGER;
      return { vendor: v, distanceKm: dist };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const candidates = ranked
    .map((r) => r.vendor)
    .filter((v) => {
      const ref = vendorIdOf(v);
      if (!ref) return true;
      return !skipRefs.has(String(ref));
    });

  console.log(
    `[DISPATCH] candidates_ranked pickupId=${pickupId} count=${candidates.length} top=${candidates
      .slice(0, 3)
      .map((v) => `${vendorIdOf(v)}@${offerUrlOf(v) || 'no_url'}`)
      .join(',')}`
  );

  // Save dispatch state
  if (dispatchState.has(pickupId)) {
    // clear previous timers
    const prev = dispatchState.get(pickupId);
    if (prev.timer) clearTimeout(prev.timer);
  }

  const state = { pickupId, candidates, index: 0, timer: null, rejectedVendorRefs: new Set() };
  dispatchState.set(pickupId, state);

  // try first candidate
  await tryOfferNext(pickupId);
}

async function tryOfferNext(pickupId) {
  const supabase = createServiceClient();
  const state = dispatchState.get(pickupId);
  if (!state) return;

  async function clearExpiredOfferIfAny() {
    const now = nowIso();
    await supabase
      .from('pickups')
      .update({ assigned_vendor_ref: null, assignment_expires_at: null })
      .eq('id', pickupId)
      .eq('status', statusFindingVendor())
      .not('assignment_expires_at', 'is', null)
      .lt('assignment_expires_at', now);
  }

  while (state.index < state.candidates.length) {
    const vendor = state.candidates[state.index];
    const vendorId = vendorIdOf(vendor);
    if (state.rejectedVendorRefs && state.rejectedVendorRefs.has(String(vendorId))) {
      console.log(`[DISPATCH] vendor_skipped_rejected pickupId=${pickupId} vendor_id=${vendorId}`);
      state.index += 1;
      continue;
    }
    const offerUrl = offerUrlOf(vendor);
    console.log(
      `[DISPATCH] vendor_selected pickupId=${pickupId} index=${state.index + 1}/${state.candidates.length} vendor_id=${vendorId} is_available=${isVendorAvailable(
        vendor
      )} offer_url=${offerUrl || ''}`
    );
    try {
      // Ensure we never overwrite an active (unexpired) offer.
      await clearExpiredOfferIfAny();

      // set assigned vendor ref and assignment_expires_at
      const expiresAt = plusMinutesIso(2);
      const { data: offered, error: offerErr } = await supabase
        .from('pickups')
        .update({
          assigned_vendor_ref: vendorId,
          assignment_expires_at: expiresAt,
          status: statusFindingVendor(),
        })
        .eq('id', pickupId)
        .eq('status', statusFindingVendor())
        .is('assigned_vendor_ref', null)
        .select('id,status,assigned_vendor_ref,assignment_expires_at')
        .maybeSingle();

      if (offerErr) throw offerErr;
      if (!offered) {
        const currentPickup = await fetchPickup(supabase, pickupId);
        if (!currentPickup) return;
        if (isTerminalStatus(currentPickup.status)) {
          console.log(`[DISPATCH] offer_aborted_terminal pickupId=${pickupId} status=${currentPickup.status}`);
          if (state.timer) clearTimeout(state.timer);
          dispatchState.delete(pickupId);
          return;
        }

        // Another worker/timer may already have an active offer out.
        if (
          currentPickup.status === statusFindingVendor() &&
          currentPickup.assigned_vendor_ref &&
          currentPickup.assignment_expires_at &&
          new Date(currentPickup.assignment_expires_at) > new Date()
        ) {
          console.log(
            `[DISPATCH] offer_skipped_active_offer pickupId=${pickupId} vendor_ref=${currentPickup.assigned_vendor_ref} expiresAt=${currentPickup.assignment_expires_at}`
          );
          return;
        }

        // Otherwise, advance and keep trying.
        state.index += 1;
        continue;
      }

      console.log(`[DISPATCH] offer_prepared pickupId=${pickupId} vendor_id=${vendorId} expiresAt=${expiresAt}`);

      // send offer
      const pickup = await fetchPickup(supabase, pickupId);
      await sendOfferToVendor(supabase, vendor, pickup);

      // set timer to handle timeout
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        handleOfferTimeout(pickupId, vendor);
      }, 2 * 60 * 1000 + 1000);

      // store updated state
      dispatchState.set(pickupId, state);
      return;
    } catch (err) {
      console.warn(
        `[DISPATCH] offer_failed pickupId=${pickupId} vendor_id=${vendorId} error=${err?.message || String(err)}`
      );
      // move to next
      state.index += 1;
      continue;
    }
  }

  // Exhausted candidates
  await supabase
    .from('pickups')
    .update({ status: statusNoVendorAvailable(), assigned_vendor_ref: null, assignment_expires_at: null })
    .eq('id', pickupId);
  dispatchState.delete(pickupId);
}

async function handleOfferTimeout(pickupId, vendor) {
  const supabase = createServiceClient();
  try {
    const { data: pickup } = await supabase.from('pickups').select('*').eq('id', pickupId).maybeSingle();
    if (!pickup) return;

    // If pickup already assigned, do nothing
    if (pickup.status === statusAssigned()) {
      dispatchState.delete(pickupId);
      return;
    }

    // If pickup is cancelled/completed, stop dispatching
    if (pickup.status === statusCancelled() || pickup.status === statusCompleted()) {
      dispatchState.delete(pickupId);
      return;
    }

    // If assignment_expires_at is in the future, don't expire yet
    if (pickup.assignment_expires_at && new Date(pickup.assignment_expires_at) > new Date()) return;

    // Clear the expired offer only if it still matches the vendor we offered.
    const offeredVendorRef = vendorIdOf(vendor);
    const now = nowIso();
    await supabase
      .from('pickups')
      .update({ assigned_vendor_ref: null, assignment_expires_at: null })
      .eq('id', pickupId)
      .eq('status', statusFindingVendor())
      .eq('assigned_vendor_ref', offeredVendorRef)
      .not('assignment_expires_at', 'is', null)
      .lt('assignment_expires_at', now);

    // Mark vendor as timed out (no history), move to next
    const state = dispatchState.get(pickupId);
    if (state) {
      state.index += 1;
      await tryOfferNext(pickupId);
      return;
    }

    // If server restarted and we lost in-memory state, restart dispatch while skipping
    // the vendor that was last offered.
    if (pickup.assigned_vendor_ref) {
      await dispatchPickup(pickupId, { skipVendorRefs: [pickup.assigned_vendor_ref] });
    } else {
      await dispatchPickup(pickupId);
    }
  } catch (e) {
    console.error('handleOfferTimeout failed', e);
  }
}

async function confirmVendorAcceptance(pickupId, assignedVendorRef) {
  const supabase = createServiceClient();

  // Strict expiry enforcement: accept only if the offer has not expired.
  const now = nowIso();

  // Atomic assignment: succeed only if this vendor is currently offered and unexpired.
  const { data, error } = await supabase
    .from('pickups')
    .update({ status: statusAssigned(), assigned_vendor_ref: assignedVendorRef, assignment_expires_at: null })
    .eq('id', pickupId)
    .eq('assigned_vendor_ref', assignedVendorRef)
    .eq('status', statusFindingVendor())
    .gte('assignment_expires_at', now)
    .select('id,status,assigned_vendor_ref')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    // Late accept / mismatched vendor / cancelled / already assigned.
    return null;
  }

  // Clear timer
  const state = dispatchState.get(pickupId);
  if (state && state.timer) clearTimeout(state.timer);
  dispatchState.delete(pickupId);

  return data;
}

async function sweepExpiredOffersOnce() {
  const supabase = createServiceClient();
  const now = nowIso();

  // Find offers that are still FINDING_VENDOR but already expired.
  const { data, error } = await supabase
    .from('pickups')
    .select('id,assigned_vendor_ref,assignment_expires_at,status')
    .eq('status', statusFindingVendor())
    .not('assignment_expires_at', 'is', null)
    .lt('assignment_expires_at', now)
    .limit(50);

  if (error) {
    console.warn('Dispatcher sweeper query failed:', error.message || error);
    return;
  }

  for (const p of data || []) {
    try {
      // Reuse timeout handler (it will restart dispatch if in-memory state is missing)
      await handleOfferTimeout(p.id, { vendor_ref: p.assigned_vendor_ref });
    } catch (e) {
      console.warn('Dispatcher sweeper failed for pickup', p.id, e?.message || e);
    }
  }
}

function startDispatcherSweeper() {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    sweepExpiredOffersOnce().catch((e) => console.warn('Dispatcher sweeper error', e?.message || e));
  }, 10 * 1000);
}

module.exports = {
  dispatchPickup,
  confirmVendorAcceptance,
  handleVendorRejection: async function (pickupId, assignedVendorRef) {
    const supabase = createServiceClient();

    // Record rejection (best-effort; does not block redispatch)
    await recordVendorRejection(supabase, pickupId, assignedVendorRef);

    // Atomically clear the assignment only if this vendor is currently offered.
    const { data: cleared, error } = await supabase
      .from('pickups')
      .update({ assigned_vendor_ref: null, assignment_expires_at: null, status: statusFindingVendor() })
      .eq('id', pickupId)
      .eq('status', statusFindingVendor())
      .eq('assigned_vendor_ref', assignedVendorRef)
      .select('id,status,assigned_vendor_ref')
      .maybeSingle();

    if (error) throw error;
    if (!cleared) {
      // Late reject or mismatched vendor; ignore.
      return null;
    }

    const state = dispatchState.get(pickupId);
    if (!state) {
      // Server likely restarted; rebuild dispatch state and continue, skipping this vendor.
      await dispatchPickup(pickupId, { skipVendorRefs: [assignedVendorRef] });
      return { restarted: true };
    }

    if (state.rejectedVendorRefs) state.rejectedVendorRefs.add(String(assignedVendorRef));

    const current = state.candidates[state.index];
    const curRef = vendorIdOf(current);
    if (String(curRef) !== String(assignedVendorRef || '')) {
      // The rejecting vendor isn't the current candidate anymore (timeout/advance happened);
      // still keep it rejected and continue dispatch if needed.
      await tryOfferNext(pickupId);
      return { advanced: true, outOfOrder: true };
    }

    state.index += 1;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    dispatchState.set(pickupId, state);
    await tryOfferNext(pickupId);
    return { advanced: true };
  },
  tryOfferNext,
  startDispatcherSweeper,
  // exported for tests/debugging
  _internal: { dispatchState },
};
