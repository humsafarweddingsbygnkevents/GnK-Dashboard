'use strict';

// Minimal in-memory rate limiter for auth endpoints. Not durable across
// serverless cold starts, but still raises the cost of a brute-force run
// against a login form sitting on a public URL.
const buckets = new Map();

function rateLimit({ max, windowMs }) {
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
