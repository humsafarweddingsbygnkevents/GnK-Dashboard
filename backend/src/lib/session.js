'use strict';

const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'hw_session';
const TOKEN_TTL = '90d';
const COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin.id, email: admin.email, role: admin.role || 'admin' },
    secret(),
    { expiresIn: TOKEN_TTL }
  );
}

function verifyAdminToken(token) {
  const payload = jwt.verify(token, secret());
  // Tokens issued before roles existed could only belong to admins.
  if (!payload.role) payload.role = 'admin';
  return payload;
}

// Long-lived + httpOnly so a logged-in admin stays logged in across visits
// without a stored password in localStorage. `secure` is skipped on plain
// local dev (http://localhost) since the cookie would otherwise be silently
// dropped by the browser.
function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

module.exports = { COOKIE_NAME, signAdminToken, verifyAdminToken, cookieOpts };
