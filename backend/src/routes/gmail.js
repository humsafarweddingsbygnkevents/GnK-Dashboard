'use strict';

const { Router } = require('express');
const { google } = require('googleapis');

const prisma = require('../lib/prisma');
const requireAdmin = require('../middleware/requireAdmin');
const router = Router();

function makeAuthClient(account) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  auth.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.expiryDate ? account.expiryDate.getTime() : undefined,
  });
  return auth;
}

function headerValue(headers, name) {
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function cleanText(raw) {
  return raw
    .replace(/<[^>]+>/g, ' ')   // strip HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[\t\r\n]+/g, ' ') // all whitespace variants → single space
    .replace(/ {2,}/g, ' ')
    .trim();
}

function extractBody(payload) {
  if (!payload) return null;

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return cleanText(Buffer.from(payload.body.data, 'base64').toString('utf8'));
  }

  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body?.data) {
      return cleanText(Buffer.from(plain.body.data, 'base64').toString('utf8'));
    }
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) {
      return cleanText(Buffer.from(html.body.data, 'base64').toString('utf8'));
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return null;
}

// Returns the raw HTML body (untouched), for rich rendering in the dashboard.
function extractHtml(payload) {
  if (!payload) return null;

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  if (payload.parts) {
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) {
      return Buffer.from(html.body.data, 'base64').toString('utf8');
    }
    for (const part of payload.parts) {
      const nested = extractHtml(part);
      if (nested) return nested;
    }
  }

  return null;
}

// Legacy Gmail-only endpoints — superseded by the unified /api/mail/* router,
// which the dashboard actually calls. Kept admin-only so the connected Gmail
// inbox can't be read by an employee hitting this directly; only /account is
// used by Settings (also admin-only: it names the connected Gmail address,
// which employees shouldn't see either).
router.get('/recent', requireAdmin, async (req, res) => {
  const account = await prisma.googleAccount.findFirst();
  if (!account) {
    return res.status(400).json({
      error: 'No Gmail account connected. Visit /auth/google to connect one.',
    });
  }

  const pageToken = req.query.pageToken || undefined;
  const maxResults = Math.min(Number(req.query.maxResults) || 15, 50);

  try {
    const auth = makeAuthClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults,
      pageToken,
    });

    const messages = listRes.data.messages ?? [];
    const emails = await Promise.all(
      messages.map(async ({ id }) => {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        });
        const headers = msg.data.payload.headers;
        return {
          id,
          subject: headerValue(headers, 'Subject'),
          from: headerValue(headers, 'From'),
          to: headerValue(headers, 'To'),
          date: headerValue(headers, 'Date'),
          body: extractBody(msg.data.payload),
          bodyHtml: extractHtml(msg.data.payload),
        };
      }),
    );

    res.json({ data: emails, nextPageToken: listRes.data.nextPageToken || null });
  } catch (err) {
    console.error('Gmail fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Encode a header value containing non-ASCII chars (RFC 2047), e.g. filenames.
function encodeHeader(str) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?utf-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function buildRawMessage({ to, subject, body, attachments }) {
  const list = Array.isArray(attachments) ? attachments : [];
  const headerSubject = encodeHeader(subject);

  if (list.length === 0) {
    return Buffer.from(
      `To: ${to}\r\n` +
      `Subject: ${headerSubject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      body
    ).toString('base64url');
  }

  const boundary = 'humsafargnk_' + Math.random().toString(36).slice(2);
  let msg =
    `To: ${to}\r\n` +
    `Subject: ${headerSubject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    `${body}\r\n`;

  for (const att of list) {
    const filename = encodeHeader(att.filename || 'attachment');
    const mimeType = att.mimeType || 'application/octet-stream';
    // att.data is already base64; re-wrap to 76-char lines per RFC 2045.
    const wrapped = (att.data || '').replace(/[\r\n]/g, '').replace(/(.{76})/g, '$1\r\n');
    msg +=
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}; name="${filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
      `${wrapped}\r\n`;
  }
  msg += `--${boundary}--`;
  return Buffer.from(msg, 'utf8').toString('base64url');
}

router.post('/send', requireAdmin, async (req, res) => {
  const { to, subject, body, attachments } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject, and body are required' });
  }

  const account = await prisma.googleAccount.findFirst();
  if (!account) {
    return res.status(400).json({
      error: 'No Gmail account connected. Visit /auth/google to connect one.',
    });
  }

  try {
    const auth = makeAuthClient(account);
    const gmail = google.gmail({ version: 'v1', auth });

    const raw = buildRawMessage({ to, subject, body, attachments });

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    res.json({ message: 'Email sent', messageId: result.data.id });
  } catch (err) {
    console.error('Gmail send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gmail/account — lightweight connection status (which inbox, if any)
// without fetching messages. Used by the Settings page.
router.get('/account', requireAdmin, async (_req, res) => {
  const account = await prisma.googleAccount.findFirst();
  if (!account) return res.json({ connected: false });
  res.json({ connected: true, email: account.email });
});

// DELETE /api/gmail/account — disconnect the connected Gmail account. Best-effort
// revokes the OAuth token with Google, then deletes the stored credentials so the
// inbox, Hwoli email, and signup access-code emails stop using it until reconnected.
router.delete('/account', requireAdmin, async (_req, res) => {
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
});

module.exports = router;
