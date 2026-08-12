'use strict';

// Gmail (OAuth) read/send helpers, shared by the /api/gmail routes and the
// merged /api/mail routes so there is one implementation of message parsing
// and MIME building.
const { google } = require('googleapis');
// Same MIME builder nodemailer uses for SMTP, so a message sent through Gmail
// and the same message sent through an IMAP account are built identically —
// multipart/alternative for text+html, multipart/related for inline cid
// images, base64 for non-ASCII bodies. The previous hand-rolled builder could
// only emit text/plain, which is what turned a forwarded photo mail into a
// wall of links.
const MailComposer = require('nodemailer/lib/mail-composer');

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
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function cleanText(raw) {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[\t\r\n]+/g, ' ')
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
    if (plain?.body?.data) return cleanText(Buffer.from(plain.body.data, 'base64').toString('utf8'));
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) return cleanText(Buffer.from(html.body.data, 'base64').toString('utf8'));
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return null;
}

// Walk the MIME tree collecting real attachments (has a filename + attachmentId),
// skipping inline images referenced by cid in the HTML body.
function extractAttachments(payload, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) {
    const cd = headerValue(payload.headers || [], 'Content-Disposition') || '';
    if (!/^inline/i.test(cd)) {
      out.push({
        filename: payload.filename,
        mimeType: payload.mimeType || 'application/octet-stream',
        size: payload.body.size || 0,
        attachmentId: payload.body.attachmentId,
      });
    }
  }
  if (payload.parts) payload.parts.forEach((p) => extractAttachments(p, out));
  return out;
}

function extractHtml(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) return Buffer.from(html.body.data, 'base64').toString('utf8');
    for (const part of payload.parts) {
      const nested = extractHtml(part);
      if (nested) return nested;
    }
  }
  return null;
}

// Builds an RFC 822 message and returns it base64url-encoded, the form the
// Gmail send API wants. `attachments` are already in nodemailer's shape
// ({ filename, content: Buffer, contentType, cid, contentDisposition }) —
// see normalizeAttachments in lib/forward.js.
async function buildRawMessage({ to, subject, body, html, attachments, inReplyTo, references }) {
  const mail = new MailComposer({
    to,
    subject: subject || '',
    text: body || '',
    ...(html ? { html } : {}),
    // Set on a reply so it threads under the message it answers.
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    attachments: Array.isArray(attachments) ? attachments : [],
    textEncoding: 'base64',
  });
  const buf = await mail.compile().build();
  return buf.toString('base64url');
}

// Fetch recent messages, returning the same email shape the dashboard expects.
// `labelIds` scopes the list to a view (INBOX, STARRED, SENT, SPAM, TRASH) —
// Gmail messages carry every label they have regardless of which view found
// them, so `unread`/`starred` are read straight off the label set.
async function fetchRecent(account, { maxResults = 15, pageToken, labelIds } = {}) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({ userId: 'me', maxResults, pageToken, labelIds });
  const messages = listRes.data.messages ?? [];
  const emails = await Promise.all(
    messages.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = msg.data.payload.headers;
      const msgLabelIds = msg.data.labelIds || [];
      return {
        id,
        subject: headerValue(headers, 'Subject'),
        from: headerValue(headers, 'From'),
        to: headerValue(headers, 'To'),
        date: headerValue(headers, 'Date'),
        body: extractBody(msg.data.payload),
        bodyHtml: extractHtml(msg.data.payload),
        unread: msgLabelIds.includes('UNREAD'),
        starred: msgLabelIds.includes('STARRED'),
        attachments: extractAttachments(msg.data.payload),
      };
    }),
  );
  return { emails, nextPageToken: listRes.data.nextPageToken || null };
}

// Downloads one attachment's raw bytes for a given message.
async function getAttachment(account, messageId, attachmentId) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  return Buffer.from(res.data.data, 'base64url');
}

// Adds/drops the UNREAD label, so opening (or re-marking unread) an email in
// the dashboard matches Gmail too. Needs the gmail.modify scope: accounts
// connected before that scope was requested throw a 403 here until they're
// reconnected in Settings, which /api/mail/read reports as a soft failure.
async function setRead(account, messageId, read) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({
    userId: 'me', id: messageId,
    requestBody: read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] },
  });
}

// Adds/removes the STARRED label.
async function setStarred(account, messageId, starred) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({
    userId: 'me', id: messageId,
    requestBody: starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] },
  });
}

// Moves a message to Gmail's Trash — same as clicking the trash icon in Gmail
// itself (recoverable from Trash for 30 days, not a permanent delete).
async function trashMessage(account, messageId) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.trash({ userId: 'me', id: messageId });
}

// The whole original message as raw RFC 822 bytes. Forwarding parses this
// with mailparser so it can carry the original's HTML body and every part —
// including the inline cid: images the message list deliberately hides.
async function getRawMessage(account, messageId) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'raw' });
  return Buffer.from(res.data.raw, 'base64url');
}

async function sendMessage(account, { to, subject, body, html, attachments, inReplyTo, references }) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = await buildRawMessage({ to, subject, body, html, attachments, inReplyTo, references });
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return result.data.id;
}

module.exports = {
  makeAuthClient, headerValue, extractBody, extractHtml, extractAttachments, buildRawMessage,
  fetchRecent, sendMessage, getAttachment, getRawMessage, setRead, setStarred, trashMessage,
};
