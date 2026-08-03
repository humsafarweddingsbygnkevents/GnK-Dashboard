'use strict';

const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');

const prisma = require('../lib/prisma');
const { COOKIE_NAME, signAdminToken, verifyAdminToken, cookieOpts } = require('../lib/session');
const { rateLimit } = require('../lib/rateLimit');
const { sendMail } = require('../lib/mailer');
const { normalizeLoginCode, hashLoginCode, createCodeForAccount } = require('../lib/loginCode');

const router = Router();
const authLimiter = rateLimit({ max: 15, windowMs: 15 * 60 * 1000 });
const otpLimiter = rateLimit({ max: 8, windowMs: 15 * 60 * 1000 });

// Where signup codes are delivered. Only this inbox ever sees a code, so a
// new user must ask the owner for it in person / over chat before they can
// finish signing up. Falls back to the owner's personal inbox.
const ADMIN_OTP_EMAIL = process.env.ADMIN_OTP_EMAIL || 'humsfarweddings@gmail.com';

// Short-lived httpOnly cookies carrying the code→Google handshake statelessly
// (works across Vercel serverless instances without a DB table):
//  - hw_signup_grant authorises /google/start?mode=signup to BIND a Gmail to
//    a freshly-verified pending account.
//  - hw_login_grant  authorises /google/start?mode=login to sign in, and
//    must match the account's already-bound Gmail (or bind it, if unbound).
const SIGNUP_GRANT_COOKIE = 'hw_signup_grant';
const LOGIN_GRANT_COOKIE = 'hw_login_grant';

function publicAdmin(admin) {
  return { id: admin.id, email: admin.email, name: admin.name, role: admin.role || 'admin' };
}

// Same attributes as the session cookie but short TTLs; reused for both
// handshake cookies so behaviour matches across environments (secure on prod).
function shortCookieOpts(maxAgeMs) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
  };
}

// Separate OAuth2 client instance from routes/auth.js (Gmail integration):
// this one only ever requests basic profile scopes for login, never Gmail
// read/send access, and uses its own redirect URI.
function makeLoginOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_LOGIN_REDIRECT_URI,
  );
}

function readGrant(req, cookieName, scope) {
  const token = req.cookies?.[cookieName];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.scope !== scope) return null;
    return payload;
  } catch {
    return null;
  }
}

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = verifyAdminToken(token);
    const admin = await prisma.admin.findUnique({ where: { id: payload.sub } });
    // Deactivated accounts lose their session on the next /me check.
    if (!admin || !admin.active) return res.status(401).json({ error: 'Not authenticated' });
    res.json(publicAdmin(admin));
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Signup step 1: name + role. Creates the account row with a fresh permanent
// login code (stored only as a hash) and emails the plaintext code ONLY to
// the owner — the requester never sees it, and must get it from the owner.
router.post('/signup/request', otpLimiter, async (req, res) => {
  const { name, role } = req.body || {};
  const cleanName = name ? String(name).trim().slice(0, 80) : '';
  if (!cleanName) return res.status(400).json({ error: 'Enter your name' });
  const cleanRole = role === 'admin' ? 'admin' : role === 'employee' ? 'employee' : null;
  if (!cleanRole) return res.status(400).json({ error: 'Choose Admin or Employee' });

  let created;
  try {
    created = await createCodeForAccount((data) =>
      prisma.admin.create({ data: { name: cleanName, role: cleanRole, ...data } }),
    );
  } catch (err) {
    console.error('signup/request create failed:', err);
    return res.status(500).json({ error: 'Could not start signup — try again' });
  }

  try {
    await sendMail({
      to: ADMIN_OTP_EMAIL,
      subject: 'Humsafar Weddings by GnK dashboard access code',
      body:
        `Someone is requesting ${cleanRole} access to the Humsafar Weddings by GnK dashboard.\n\n` +
        `  Name: ${cleanName}\n` +
        `  Role: ${cleanRole}\n\n` +
        `Access code: ${created.code}\n\n` +
        `This is their PERMANENT login code — share it with them only if you recognise ` +
        `them. They'll use it every time they log in. You can regenerate it anytime from ` +
        `the Team screen if it leaks or they lose it.\n` +
        `If you don't recognise this request, ignore this email and delete the pending ` +
        `signup from the Team screen.`,
    });
  } catch (err) {
    console.error('signup/request email failed:', err.message);
    await prisma.admin.delete({ where: { id: created.account.id } }).catch(() => {});
    return res.status(502).json({ error: 'Could not send the code right now — try again shortly' });
  }

  res.json({ ok: true });
});

// Signup step 2: user enters the code the owner gave them. Verified against
// the DB (not a stateless cookie — the code is permanent, so it must live in
// the DB from creation). On success, mint a grant that authorises binding a
// Gmail account to this row.
router.post('/signup/verify', otpLimiter, async (req, res) => {
  try {
    const code = normalizeLoginCode(req.body?.code);
    if (code.length !== 8) return res.status(400).json({ error: 'Enter the 8-character code' });

    const account = await prisma.admin.findUnique({ where: { loginCodeHash: hashLoginCode(code) } });
    if (!account) return res.status(401).json({ error: 'Incorrect code — check with the owner and try again' });
    if (!account.active) return res.status(403).json({ error: 'This account is disabled' });
    if (account.googleId) return res.status(409).json({ error: 'This code is already registered — log in instead' });

    const grant = jwt.sign({ sub: account.id, scope: 'signup' }, process.env.JWT_SECRET, { expiresIn: '15m' });
    res.cookie(SIGNUP_GRANT_COOKIE, grant, shortCookieOpts(15 * 60 * 1000));
    res.json({ ok: true, name: account.name });
  } catch (err) {
    console.error('signup/verify failed:', err);
    res.status(500).json({ error: 'Could not verify the code — try again' });
  }
});

// Login step 1: the user's permanent code. On success, mint a grant that
// authorises the Google handshake for this specific account.
router.post('/login/verify', authLimiter, async (req, res) => {
  try {
    const code = normalizeLoginCode(req.body?.code);
    if (code.length !== 8) return res.status(400).json({ error: 'Enter your 8-character code' });

    const account = await prisma.admin.findUnique({ where: { loginCodeHash: hashLoginCode(code) } });
    if (!account) return res.status(401).json({ error: 'Incorrect code' });
    if (!account.active) return res.status(403).json({ error: 'This account has been disabled — contact the admin' });

    const grant = jwt.sign({ sub: account.id, scope: 'login' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.cookie(LOGIN_GRANT_COOKIE, grant, shortCookieOpts(10 * 60 * 1000));
    res.json({ ok: true, name: account.name, bound: !!account.googleId });
  } catch (err) {
    console.error('login/verify failed:', err);
    res.status(500).json({ error: 'Could not verify the code — try again' });
  }
});

// mode=signup requires a valid signup grant (minted by /signup/verify) and
// binds whichever Gmail the user connects to that exact account.
// mode=login requires a valid login grant (minted by /login/verify) and only
// signs in — it never creates an account.
router.get('/google/start', (req, res) => {
  const mode = req.query.mode === 'signup' ? 'signup' : 'login';

  const grant = mode === 'signup'
    ? readGrant(req, SIGNUP_GRANT_COOKIE, 'signup')
    : readGrant(req, LOGIN_GRANT_COOKIE, 'login');
  if (!grant) return res.redirect('/?authError=code_required');

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_LOGIN_REDIRECT_URI) {
    return res.redirect('/?authError=google_not_configured');
  }

  const state = jwt.sign({ mode, sub: grant.sub }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const auth = makeLoginOAuthClient();
  const url = auth.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  });
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?authError=google_error');
  if (!code || !state) return res.redirect('/?authError=google_error');

  let statePayload;
  try {
    statePayload = jwt.verify(state, process.env.JWT_SECRET);
  } catch {
    return res.redirect('/?authError=bad_state');
  }

  const clearGrants = () => {
    res.clearCookie(SIGNUP_GRANT_COOKIE, { path: '/' });
    res.clearCookie(LOGIN_GRANT_COOKIE, { path: '/' });
  };

  try {
    const auth = makeLoginOAuthClient();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth });
    const { data: profile } = await oauth2.userinfo.get();
    if (!profile.email || !profile.verified_email) {
      clearGrants();
      return res.redirect('/?authError=unverified_email');
    }
    const email = profile.email.toLowerCase();

    let account = await prisma.admin.findUnique({ where: { id: statePayload.sub } });
    if (!account) {
      clearGrants();
      return res.redirect('/?authError=bad_state');
    }
    if (!account.active) {
      clearGrants();
      return res.redirect('/?authError=account_disabled');
    }

    if (account.googleId) {
      // Already bound — only that exact Google account may use this code.
      if (account.googleId !== profile.id) {
        clearGrants();
        return res.redirect('/?authError=wrong_google_account');
      }
    } else {
      // First Google connection for this account — bind it, guarding against
      // this Gmail already belonging to a different account.
      const collision = await prisma.admin.findFirst({
        where: { id: { not: account.id }, OR: [{ email }, { googleId: profile.id }] },
      });
      if (collision) {
        clearGrants();
        return res.redirect('/?authError=account_exists');
      }
      account = await prisma.admin.update({
        where: { id: account.id },
        data: { email, googleId: profile.id, name: account.name || profile.name || null },
      });
    }

    clearGrants();

    if (statePayload.mode === 'signup') {
      return res.redirect('/?registered=1');
    }
    res.cookie(COOKIE_NAME, signAdminToken(account), cookieOpts());
    res.redirect('/');
  } catch (err) {
    console.error('Admin Google OAuth callback error:', err);
    clearGrants();
    res.redirect('/?authError=google_error');
  }
});

module.exports = router;
