'use strict';

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

// Known providers → default IMAP/SMTP hosts so the user only needs to type
// their email + password. 'custom' lets them enter hosts manually.
// GoDaddy sells two different email products and they share no hostnames:
//   - Titan ("Professional Email") — everything sold since ~2020, *.titan.email
//   - Workspace Email — the legacy product, *.secureserver.net
// The two share no hostnames, so picking the wrong one cannot work — which is
// why verifyImapWithFallback below always tries the sibling product too.
// humsafarweddingsbygnk.in is on Workspace (MX = mailstore1.secureserver.net),
// so 'godaddy' is the default both in the UI and for an unrecognised provider.
const PROVIDERS = {
  titan: {
    label: 'GoDaddy Professional Email (Titan)',
    imapHost: 'imap.titan.email', imapPort: 993,
    smtpHost: 'smtp.titan.email', smtpPort: 465,
  },
  godaddy: {
    label: 'GoDaddy Workspace (legacy)',
    imapHost: 'imap.secureserver.net', imapPort: 993,
    smtpHost: 'smtpout.secureserver.net', smtpPort: 465,
  },
  office365: {
    label: 'Microsoft 365',
    imapHost: 'outlook.office365.com', imapPort: 993,
    smtpHost: 'smtp.office365.com', smtpPort: 587,
  },
  custom: {
    label: 'Custom IMAP/SMTP',
    imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465,
  },
};

// Merge a provider preset with any explicit host/port overrides from the caller.
function resolveHosts(provider, overrides = {}) {
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  return {
    imapHost: overrides.imapHost || preset.imapHost,
    imapPort: overrides.imapPort || preset.imapPort,
    smtpHost: overrides.smtpHost || preset.smtpHost,
    smtpPort: overrides.smtpPort || preset.smtpPort,
  };
}

function makeImapClient({ imapHost, imapPort, email, password }) {
  return new ImapFlow({
    host: imapHost,
    port: Number(imapPort) || 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    // Fail fast rather than hanging a request if the host is wrong/unreachable.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

// Verify credentials by connecting and logging out. Throws a friendly error on
// failure — used before persisting a new account so we never store bad creds.
async function verifyImap({ imapHost, imapPort, email, password }) {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch (err) {
    try { await client.close(); } catch (_) {}
    throw new Error(friendlyImapError(err));
  }
}

// The two GoDaddy products are indistinguishable from the customer's side — the
// MX record is the only real tell — and picking the wrong one fails with a plain
// auth error rather than anything diagnostic. So when a GoDaddy preset is used
// verbatim, verifyImapWithFallback silently retries against the sibling product.
const GODADDY_SIBLING = { titan: 'godaddy', godaddy: 'titan' };

// Verify credentials, transparently retrying the sibling GoDaddy host if the
// selected one is rejected. Returns the provider/hosts that actually worked so
// the caller persists the working configuration, not the one that was picked.
async function verifyImapWithFallback({ provider, overrides = {}, email, password }) {
  const order = [provider];
  // Only fall back when the preset was used as-is; explicit hosts are a
  // deliberate choice and shouldn't be silently swapped out.
  if (!overrides.imapHost && GODADDY_SIBLING[provider]) order.push(GODADDY_SIBLING[provider]);

  // When every host fails, report the most actionable error rather than the
  // first one: a host we merely couldn't reach says nothing, but a server that
  // reached LOGIN and rejected it tells the user their password is wrong.
  let firstErr;
  let authErr;
  for (const prov of order) {
    const hosts = resolveHosts(prov, overrides);
    try {
      await verifyImap({ imapHost: hosts.imapHost, imapPort: hosts.imapPort, email, password });
      return { provider: prov, hosts };
    } catch (err) {
      if (!firstErr) firstErr = err;
      if (!authErr && /^Login failed/.test(err.message || '')) authErr = err;
    }
  }
  throw authErr || firstErr;
}

function friendlyImapError(err) {
  const m = (err && (err.message || err.responseText)) || String(err);
  // imapflow sets authenticationFailed when the LOGIN command is rejected; the
  // raw message for that is often just "Command failed".
  if (err && (err.authenticationFailed || err.serverResponseCode === 'AUTHENTICATIONFAILED')
      || /auth|credential|login|AUTHENTICATIONFAILED|Command failed/i.test(m)) {
    return 'Login failed — use your full email address as the username and the mailbox password (not your GoDaddy account password). If the mailbox has 2-step verification on, create an app password and use that.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'Could not reach the mail server — check the IMAP host.';
  if (/timeout|ETIMEDOUT/i.test(m)) return 'Connection to the mail server timed out — check the host, port, or firewall.';
  return 'Could not connect to the mailbox: ' + m;
}

// Fetch the most recent `limit` messages from INBOX, newest first. Each item is
// shaped to match the Gmail route's email objects so the frontend can render
// both identically. `uid` is returned so callers can build a stable id.
async function fetchRecent({ imapHost, imapPort, email, password }, limit = 20) {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  const out = [];
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const total = client.mailbox.exists || 0;
    if (total === 0) return [];
    const start = Math.max(1, total - limit + 1);
    const range = `${start}:*`;

    for await (const msg of client.fetch(range, { source: true, flags: true, uid: true })) {
      let parsed;
      try {
        parsed = await simpleParser(msg.source);
      } catch (_) {
        continue;
      }
      out.push({
        uid: msg.uid,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        date: (parsed.date || new Date()).toISOString(),
        body: (parsed.text || '').trim(),
        bodyHtml: parsed.html || null,
        unread: !(msg.flags && msg.flags.has('\\Seen')),
        // Metadata only here — actual bytes are fetched on demand via fetchAttachment
        // so the recent-list poll doesn't have to pull every attachment's content.
        attachments: (parsed.attachments || [])
          .filter((a) => a.contentDisposition !== 'inline')
          .map((a) => ({
            filename: a.filename || 'attachment',
            mimeType: a.contentType || 'application/octet-stream',
            size: a.size || (a.content ? a.content.length : 0),
          })),
      });
    }
  } finally {
    lock.release();
    try { await client.logout(); } catch (_) {}
  }
  // fetch returns ascending order; newest first for the merged inbox.
  return out.reverse();
}

// Re-fetches a single message by its stable IMAP UID and returns one attachment's
// bytes, matched by filename. Used for on-demand attachment downloads.
async function fetchAttachment({ imapHost, imapPort, email, password }, uid, filename) {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    let parsed = null;
    for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
      parsed = await simpleParser(msg.source);
      break;
    }
    if (!parsed) throw new Error('Message not found');
    const att = (parsed.attachments || []).find((a) => (a.filename || 'attachment') === filename);
    if (!att) throw new Error('Attachment not found');
    return { content: att.content, contentType: att.contentType || 'application/octet-stream', filename: att.filename || 'attachment' };
  } finally {
    lock.release();
    try { await client.logout(); } catch (_) {}
  }
}

// Send a message over SMTP for a non-Gmail (IMAP) account.
async function sendSmtp({ smtpHost, smtpPort, email, password }, { to, subject, body, attachments }) {
  const port = Number(smtpPort) || 465;
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: email, pass: password },
  });
  const info = await transporter.sendMail({
    from: email,
    to,
    subject,
    text: body,
    attachments: (Array.isArray(attachments) ? attachments : []).map((a) => ({
      filename: a.filename || 'attachment',
      content: Buffer.from(a.data || '', 'base64'),
      contentType: a.mimeType || 'application/octet-stream',
    })),
  });
  return info.messageId;
}

module.exports = { PROVIDERS, resolveHosts, verifyImap, verifyImapWithFallback, fetchRecent, sendSmtp, fetchAttachment };
