'use strict';

// Gmail (OAuth) read/send helpers, shared by the /api/gmail routes and the
// merged /api/mail routes so there is one implementation of message parsing
// and MIME building.
const { google } = require('googleapis');

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

// Fetch recent messages, returning the same email shape the dashboard expects.
async function fetchRecent(account, { maxResults = 15, pageToken } = {}) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({ userId: 'me', maxResults, pageToken });
  const messages = listRes.data.messages ?? [];
  const emails = await Promise.all(
    messages.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const headers = msg.data.payload.headers;
      const labelIds = msg.data.labelIds || [];
      return {
        id,
        subject: headerValue(headers, 'Subject'),
        from: headerValue(headers, 'From'),
        to: headerValue(headers, 'To'),
        date: headerValue(headers, 'Date'),
        body: extractBody(msg.data.payload),
        bodyHtml: extractHtml(msg.data.payload),
        unread: labelIds.includes('UNREAD'),
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

// Drops the UNREAD label from one message, so an email opened in the dashboard
// is read in Gmail too. Needs the gmail.modify scope: accounts connected before
// that scope was requested throw a 403 here until they're reconnected in
// Settings, which /api/mail/read reports as a soft failure.
async function markRead(account, messageId) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({
    userId: 'me', id: messageId, requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

async function sendMessage(account, { to, subject, body, attachments }) {
  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to, subject, body, attachments });
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return result.data.id;
}

module.exports = {
  makeAuthClient, headerValue, extractBody, extractHtml, extractAttachments, buildRawMessage,
  fetchRecent, sendMessage, getAttachment, markRead,
};
