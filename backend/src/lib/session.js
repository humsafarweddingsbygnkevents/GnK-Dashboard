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
    { sub: admin.id, email: admin.email, role: admin.role || 'admin', typ: 'session' },
    secret(),
    { expiresIn: TOKEN_TTL }
  );
}

// The signup/login grant cookies and the OAuth `state` param are also JWTs
// signed with this same secret, but they authorise a single narrow step of
// the login handshake, not a full session. Without this check, one of those
// short-lived tokens could be replayed as the `hw_session` cookie itself —
// skipping the Google OAuth step entirely. Every real session token is
// stamped `typ: 'session'` at mint time, so anything missing it is rejected.
function verifyAdminToken(token) {
  const payload = jwt.verify(token, secret());
  if (payload.typ !== 'session') throw new Error('Not a session token');
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
