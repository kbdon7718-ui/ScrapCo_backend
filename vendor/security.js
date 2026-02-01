const crypto = require('crypto');

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function hmacSha256Hex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyVendorSignature(req) {
  // ✅ DEV / LOCAL BYPASS
  

  // 🔐 PRODUCTION MODE
  const secret = process.env.VENDOR_WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: 'VENDOR_WEBHOOK_SECRET is not configured' };

  const got = req.headers['x-scrapco-signature'];
  if (!got) return { ok: false, error: 'Missing x-scrapco-signature header' };

  const raw = req.rawBody;
  if (!raw) return { ok: false, error: 'Missing raw body (server misconfigured)' };

  const expected = hmacSha256Hex(secret, raw);
  if (!safeEqual(String(got), expected)) return { ok: false, error: 'Invalid signature' };

  return { ok: true };
}

module.exports = {
  verifyVendorSignature,
  hmacSha256Hex,
};
