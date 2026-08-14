'use strict';

const { Router } = require('express');

const prisma = require('../lib/prisma');
const requireAdmin = require('../middleware/requireAdmin');
const router = Router();

// GET /api/gmail/account — lightweight connection status (which inbox, if any)
// without fetching messages. Used by the Settings page. Fetching/sending mail
// itself lives in the unified /api/mail/* router (routes/mail.js), which is
// what the dashboard actually calls — this router used to duplicate that as
// /recent and /send, but nothing has called either in a long time; removed
// rather than kept as a second, drifting implementation of the same thing.
router.get('/account', requireAdmin, async (_req, res) => {
  try {
    const account = await prisma.googleAccount.findFirst();
    if (!account) return res.json({ connected: false });
    res.json({ connected: true, email: account.email });
  } catch (err) {
    console.error('Gmail account status error:', err);
    res.status(500).json({ error: 'Could not check Gmail connection status' });
  }
});

// DELETE /api/gmail/account — disconnect the connected Gmail account. Best-effort
// revokes the OAuth token with Google, then deletes the stored credentials so the
// inbox, Hwoli email, and signup access-code emails stop using it until reconnected.
router.delete('/account', requireAdmin, async (_req, res) => {
  try {
    const account = await prisma.googleAccount.findFirst();
    if (!account) return res.status(404).json({ error: 'No Gmail account connected' });

    const token = account.refreshToken || account.accessToken;
    if (token) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } catch (err) {
        // Don't block disconnect on a revoke failure — the local record is what matters.
        console.warn('Gmail token revoke failed (continuing):', err.message);
      }
    }

    await prisma.googleAccount.delete({ where: { id: account.id } });
    res.json({ disconnected: true, email: account.email });
  } catch (err) {
    console.error('Gmail disconnect error:', err);
    res.status(500).json({ error: 'Could not disconnect the Gmail account' });
  }
});

module.exports = router;
