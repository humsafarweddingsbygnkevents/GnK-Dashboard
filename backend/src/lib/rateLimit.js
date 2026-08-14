'use strict';

// Minimal in-memory rate limiter for auth endpoints. Not durable across
// serverless cold starts, but still raises the cost of a brute-force run
// against a login form sitting on a public URL.
//
// Each call to rateLimit() gets its OWN bucket Map, keyed by IP within that
// call only. Previously this Map was declared at module scope, so every
// limiter instance (authLimiter, signupRequestLimiter, signupVerifyLimiter,
// deleteLimiter, ...) shared one bucket per IP — hammering one endpoint
// silently ate into a totally different endpoint's budget for that IP
// (e.g. exhausting signupRequestLimiter's tight 5-per-15min budget just by
// making unrelated /login/verify calls from a shared/NAT IP).
function rateLimit({ max, windowMs }) {
  const buckets = new Map();

  // An expired bucket just sits there until that same IP happens to hit this
  // limiter again — harmless per-entry, but on a long-lived process (local
  // dev, or a Vercel instance kept warm across many different IPs) the Map
  // only ever grows. Sweep expired entries on a timer instead of inline per
  // request, so the request path stays O(1). unref() so this timer can't by
  // itself keep a plain `node script.js` process alive.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < now) buckets.delete(key);
    }
  }, windowMs);
  sweep.unref?.();

  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
    }
    bucket.count += 1;
    next();
  };
}

module.exports = { rateLimit };
