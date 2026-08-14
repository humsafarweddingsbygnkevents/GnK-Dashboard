'use strict';

const prisma = require('./prisma');
const { sendMessage } = require('./gmailClient');

// Reuses the Gmail account already connected for the dashboard (the same
// token used by routes/gmail.js and routes/mail.js) to send plain
// transactional mail — currently the signup OTP that goes to the admin.
// Delegates the actual OAuth client + MIME building to gmailClient.js rather
// than keeping a second copy of both: a previous local copy of
// buildRawMessage here didn't sanitize `to`/`subject` for header injection
// the way gmailClient.js's does, so two independent implementations had
// already drifted out of sync on a security-relevant detail.
async function sendMail({ to, subject, body }) {
  const account = await prisma.googleAccount.findFirst();
  if (!account) throw new Error('No Gmail account connected');
  return sendMessage(account, { to, subject, body });
}

module.exports = { sendMail };
