'use strict';

const { Router } = require('express');
const { google } = require('googleapis');

const prisma = require('../lib/prisma');
const router = Router();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  // Opening an email marks it read, which means removing its UNREAD label —
  // something readonly can't do. Gmail accounts connected before this scope was
  // added keep working; /api/mail/read reports their 403 as a soft failure and
  // the dashboard falls back to its own read state until they're reconnected.
  'https://www.googleapis.com/auth/gmail.modify',
];

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

router.get('/google', (_req, res) => {
  const auth = makeOAuth2Client();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    // 'select_account' forces Google's account chooser to show, instead of
    // silently signing in with whichever Google account is already logged
    // into the browser. 'consent' ensures a refresh_token is issued every time.
    prompt: 'select_account consent',
    scope: SCOPES,
  });
  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).json({ error: `Google OAuth error: ${error}` });
  }
  if (!code) {
    return res.status(400).json({ error: 'Missing code parameter' });
  }

  try {
    const auth = makeOAuth2Client();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth });
    const { data: profile } = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.emailAddress;

    const expiryDate = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

    await prisma.googleAccount.upsert({
      where: { email },
      update: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        expiryDate,
      },
      create: {
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate,
      },
    });

    res.json({ message: `Connected Gmail account: ${email}` });
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
