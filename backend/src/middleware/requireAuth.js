'use strict';

const prisma = require('../lib/prisma');
const { COOKIE_NAME, verifyAdminToken } = require('../lib/session');

// Sessions are stateless 90-day JWTs with no revocation list, so signature
// validity alone isn't enough: deactivating an account from the Team screen
// used to only take effect the next time that account happened to hit /me —
// every other route (attendance, clients, feedback, ...) kept trusting the
// old cookie for up to 90 days. Re-checking `active` here, on every request,
// closes that gap for all of them. Read-only — no write happens on this path.
module.exports = async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = verifyAdminToken(token);
    const account = await prisma.admin.findUnique({ where: { id: payload.sub }, select: { active: true } });
    if (!account || !account.active) {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json({ error: 'Session expired' });
    }
    req.admin = payload;
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.status(401).json({ error: 'Session expired' });
  }
};
