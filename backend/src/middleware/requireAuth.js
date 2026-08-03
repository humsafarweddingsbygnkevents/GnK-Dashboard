'use strict';

const { COOKIE_NAME, verifyAdminToken } = require('../lib/session');

module.exports = function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.admin = verifyAdminToken(token);
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.status(401).json({ error: 'Session expired' });
  }
};
