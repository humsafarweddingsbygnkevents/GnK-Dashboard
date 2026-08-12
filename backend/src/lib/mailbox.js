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

// Special-use folder resolution (RFC 6154) for Sent/Trash/Spam, with a
// name-based fallback for providers that don't advertise SPECIAL-USE.
const SPECIAL_USE_FLAG = { sent: '\\Sent', trash: '\\Trash', spam: '\\Junk' };
const FOLDER_NAME_HINTS = {
  sent: [/^sent$/i, /sent items/i, /sent messages/i],
  trash: [/^trash$/i, /deleted items/i, /deleted messages/i, /^bin$/i],
  spam: [/^junk$/i, /junk e-?mail/i, /^spam$/i],
};

// Looks at every mailbox the account exposes and picks the one that best
// matches the requested kind. Must be called on an already-connected client.
async function findFolder(client, kind) {
  const list = await client.list();
  const flag = SPECIAL_USE_FLAG[kind];
  let found = flag ? list.find((m) => m.specialUse === flag) : null;
  if (!found) {
    const hints = FOLDER_NAME_HINTS[kind] || [];
    found = list.find((m) => hints.some((re) => re.test(m.name || '') || re.test(m.path || '')));
  }
  return found ? found.path : null;
}

// Resolves which real mailbox a unified "view" reads/writes against. 'inbox'
// and 'starred' both live in INBOX (starred is a flag, not a folder); the
// others are separate folders looked up per-account since path names vary
// ("Sent" vs "Sent Items" vs "INBOX.Sent").
async function resolveViewPath(client, view) {
  if (view === 'sent' || view === 'spam' || view === 'trash') {
    return (await findFolder(client, view)) || 'INBOX';
  }
  return 'INBOX';
}

// Parses one already-fetched IMAP message into the shape the dashboard expects.
async function parseMessage(msg) {
  const parsed = await simpleParser(msg.source);
  return {
    uid: msg.uid,
    subject: parsed.subject || '(no subject)',
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    date: (parsed.date || new Date()).toISOString(),
    body: (parsed.text || '').trim(),
    bodyHtml: parsed.html || null,
    unread: !(msg.flags && msg.flags.has('\\Seen')),
    starred: !!(msg.flags && msg.flags.has('\\Flagged')),
    // Metadata only here — actual bytes are fetched on demand via fetchAttachment
    // so the recent-list poll doesn't have to pull every attachment's content.
    attachments: (parsed.attachments || [])
      .filter((a) => a.contentDisposition !== 'inline')
      .map((a) => ({
        filename: a.filename || 'attachment',
        mimeType: a.contentType || 'application/octet-stream',
        size: a.size || (a.content ? a.content.length : 0),
      })),
  };
}

// Fetches the newest `limit` messages from an already-opened mailbox. When
// `flaggedOnly` is set, searches for \Flagged messages instead of taking the
// tail of the mailbox — used for the cross-folder-free "Starred" view, which
// only ever looks inside INBOX (starring rarely matters outside it for a
// shared support mailbox, and searching every folder per account would be
// slow for no real benefit here).
async function fetchMailboxMessages(client, path, limit, { flaggedOnly = false } = {}) {
  const out = [];
  const lock = await client.getMailboxLock(path);
  try {
    let range;
    let useUid = false;
    if (flaggedOnly) {
      const uids = await client.search({ flagged: true }, { uid: true });
      if (!uids || !uids.length) return [];
      range = uids.slice(-limit).join(',');
      useUid = true;
    } else {
      const total = client.mailbox.exists || 0;
      if (total === 0) return [];
      const start = Math.max(1, total - limit + 1);
      range = `${start}:*`;
    }
    for await (const msg of client.fetch(range, { source: true, flags: true, uid: true }, useUid ? { uid: true } : undefined)) {
      try {
        out.push(await parseMessage(msg));
      } catch (_) {
        continue;
      }
    }
  } finally {
    lock.release();
  }
  // fetch returns ascending order; newest first for the merged inbox.
  return out.reverse();
}

// Fetch recent messages from INBOX, newest first.
async function fetchRecent({ imapHost, imapPort, email, password }, limit = 20) {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  try {
    return await fetchMailboxMessages(client, 'INBOX', limit);
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// Fetch \Flagged (starred) messages from INBOX, newest first.
async function fetchStarred({ imapHost, imapPort, email, password }, limit = 20) {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  try {
    return await fetchMailboxMessages(client, 'INBOX', limit, { flaggedOnly: true });
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// Fetch recent messages from a special-use folder (Sent/Spam/Trash). Returns
// an empty list (not an error) when the account has no such folder — some
// minimal IMAP setups genuinely don't expose one.
async function fetchFolder({ imapHost, imapPort, email, password }, kind, limit = 20) {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  try {
    const path = await findFolder(client, kind);
    if (!path) return [];
    return await fetchMailboxMessages(client, path, limit);
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// Re-fetches a single message by its stable IMAP UID and returns one attachment's
// bytes, matched by filename. `view` picks the folder the message lives in.
async function fetchAttachment({ imapHost, imapPort, email, password }, uid, filename, view = 'inbox') {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  try {
    const path = await resolveViewPath(client, view);
    const lock = await client.getMailboxLock(path);
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
    }
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// The whole original message as raw RFC 822 bytes, by UID. Forwarding parses
// this so it can carry the original's HTML body and every part — including the
// inline cid: images parseMessage deliberately leaves out of the list view.
async function fetchRawMessage({ imapHost, imapPort, email, password }, uid, view = 'inbox') {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  try {
    const path = await resolveViewPath(client, view);
    const lock = await client.getMailboxLock(path);
    try {
      for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
        return msg.source;
      }
      throw new Error('Message not found');
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// Adds or removes an IMAP flag (\Seen, \Flagged) on one message by UID.
// `view` resolves which folder the message currently lives in.
async function setFlag({ imapHost, imapPort, email, password }, uid, flag, on, view = 'inbox') {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  try {
    const path = await resolveViewPath(client, view);
    const lock = await client.getMailboxLock(path);
    try {
      if (on) return await client.messageFlagsAdd(String(uid), [flag], { uid: true });
      return await client.messageFlagsRemove(String(uid), [flag], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// Sets the \Seen flag on one message by UID, so opening an email in the
// dashboard makes it read in the real mailbox too — and it stays read the next
// time fetchRecent() reports its flags.
async function markSeen(creds, uid, view = 'inbox') {
  return setFlag(creds, uid, '\\Seen', true, view);
}

// Clears the \Seen flag — the IMAP side of "Mark as unread".
async function markUnseen(creds, uid, view = 'inbox') {
  return setFlag(creds, uid, '\\Seen', false, view);
}

// Sets/clears \Flagged — the IMAP side of starring a message.
async function setStarred(creds, uid, starred, view = 'inbox') {
  return setFlag(creds, uid, '\\Flagged', starred, view);
}

// Moves a message by UID into the account's Trash folder. `view` is the
// folder the message currently lives in. Throws if the account has no
// resolvable Trash folder — nothing to move it into.
async function moveToTrash({ imapHost, imapPort, email, password }, uid, view = 'inbox') {
  const client = makeImapClient({ imapHost, imapPort, email, password });
  await client.connect();
  try {
    const srcPath = await resolveViewPath(client, view);
    const trashPath = await findFolder(client, 'trash');
    if (!trashPath) throw new Error('This mailbox has no Trash folder');
    if (srcPath === trashPath) return; // already there
    const lock = await client.getMailboxLock(srcPath);
    try {
      await client.messageMove(String(uid), trashPath, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

// Send a message over SMTP for a non-Gmail (IMAP) account. `attachments` are
// already nodemailer-shaped ({ filename, content: Buffer, contentType, cid,
// contentDisposition }) — see normalizeAttachments in lib/forward.js — so an
// inline cid: image forwarded from an original still resolves in the HTML.
async function sendSmtp({ smtpHost, smtpPort, email, password }, { to, subject, body, html, attachments, inReplyTo, references }) {
  const port = Number(smtpPort) || 465;
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: email, pass: password },
    // Same reasoning as makeImapClient: without these a stalled relay keeps the
    // HTTP request open long past any useful wait, and the dashboard sits on a
    // spinner with nothing to report. Fail with an error the sender can act on.
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 120000,
  });
  const info = await transporter.sendMail({
    from: email,
    to,
    subject,
    text: body,
    ...(html ? { html } : {}),
    // Set on a reply so it threads under the message it answers.
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    attachments: Array.isArray(attachments) ? attachments : [],
  });
  return info.messageId;
}

module.exports = {
  PROVIDERS, resolveHosts, verifyImap, verifyImapWithFallback,
  fetchRecent, fetchStarred, fetchFolder, sendSmtp, fetchAttachment, fetchRawMessage,
  markSeen, markUnseen, setStarred, moveToTrash,
};
