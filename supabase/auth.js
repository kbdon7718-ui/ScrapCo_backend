function getBearerToken(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  const parts = String(h).split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  return null;
}

module.exports = { getBearerToken };
