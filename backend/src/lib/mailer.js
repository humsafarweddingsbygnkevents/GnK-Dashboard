'use strict';

const { google } = require('googleapis');
const prisma = require('./prisma');

// Reuses the Gmail account already connected for the dashboard (the same
// token used by routes/gmail.js) to send plain transactional mail —
// currently the signup OTP that goes to the admin.
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

function buildRawMessage({ to, subject, body }) {
  const headerSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const msg =
    `To: ${to}\r\n` +
    `Subject: ${headerSubject}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    body;
  return Buffer.from(msg, 'utf8').toString('base64url');
}

async function sendMail({ to, subject, body }) {
  const account = await prisma.googleAccount.findFirst();
  if (!account) throw new Error('No Gmail account connected');

  const auth = makeAuthClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage({ to, subject, body });
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return result.data.id;
}

module.exports = { sendMail };
