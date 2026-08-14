'use strict';

// Unified inbox across providers: Gmail (OAuth, via GoogleAccount) and generic
// IMAP/SMTP mailboxes (via MailAccount, e.g. GoDaddy Workspace). Serves a merged
// recent list, account management, and provider-aware sending.
const { Router } = require('express');
const { simpleParser } = require('mailparser');

const prisma = require('../lib/prisma');
const gmailClient = require('../lib/gmailClient');
const mailbox = require('../lib/mailbox');
const { buildForward, buildReply, normalizeAttachments } = require('../lib/forward');
const { encrypt, decrypt, DecryptError, keySource } = require('../lib/crypto');
const requireAdmin = require('../middleware/requireAdmin');

const router = Router();

// Employees only ever see/use the shared "info@" and "sales@" mailboxes —
// the owner's personal Gmail account stays admin-only. Extend this set if
// more shared mailboxes are added later; no schema change needed.
const EMPLOYEE_VISIBLE_EMAILS = new Set([
  'info@humsafarweddingsbygnk.in',
  'sales@humsafarweddingsbygnk.in',
]);

function isAdmin(req) {
  return req.admin?.role === 'admin';
}

function imapAccountLabel(m) {
  return m.label || mailbox.PROVIDERS[m.provider]?.label || 'Email';
}

// Unified inbox "views" beyond the default merged INBOX. 'unread' isn't here —
// it's a client-side filter over the inbox view, not a separate mailbox.
const MAIL_VIEWS = new Set(['inbox', 'starred', 'sent', 'spam', 'trash']);
const GMAIL_VIEW_LABELS = { inbox: ['INBOX'], starred: ['STARRED'], sent: ['SENT'], spam: ['SPAM'], trash: ['TRASH'] };

// Parses a unified message id into its parts. Gmail ids are stable regardless
// of label/view: "gmail:<acctId>:<messageId>". IMAP ids carry the view they
// were fetched under, since Sent/Spam/Trash are separate mailboxes and a UID
// is only unique within one: "imap:<acctId>:<view>:<uid>" (older cached ids
// without a view, from before views existed, are treated as 'inbox').
function parseMailId(id) {
  const m = /^(gmail|imap):([^:]+):(.+)$/.exec(String(id || ''));
  if (!m) return null;
  const [, type, acctIdStr, rest] = m;
  const acctId = Number(acctIdStr);
  if (!acctId) return null;
  if (type === 'gmail') return { type, acctId, view: null, msgPart: rest };
  const vm = /^(inbox|starred|sent|spam|trash):(.+)$/.exec(rest);
  return vm ? { type, acctId, view: vm[1], msgPart: vm[2] } : { type, acctId, view: 'inbox', msgPart: rest };
}

// Decrypt a stored mailbox password, turning the one failure mode users
// actually hit — ciphertext saved under a different MAIL_ENC_KEY/JWT_SECRET
// than the one this deploy runs with — into a message that says which
// mailbox broke and what to do. Node's own wording for this is
// "Unsupported state or unable to authenticate data", which tells nobody
// anything and reads like the mail provider rejected the login.
function unlock(acct) {
  try {
    return decrypt(acct.passwordEnc);
  } catch (err) {
    if (err instanceof DecryptError) {
      console.error(
        `[mail] Cannot decrypt saved password for ${acct.email} — the encryption key changed ` +
        `since it was saved (currently using ${keySource()}). Re-save the password in Settings → Mailboxes.`,
      );
      throw Object.assign(
        new Error(`Saved password for ${acct.email} can't be unlocked — re-enter it in Settings → Mailboxes`),
        { status: 400, code: 'DECRYPT_FAILED' },
      );
    }
    throw err;
  }
}

// Never returns the password or its ciphertext. `needsPassword` lets Settings
// flag a mailbox whose stored password no longer opens under the current key,
// so it's obvious which one to re-save without digging through server logs.
function publicMailAccount(a) {
  let needsPassword = false;
  try { decrypt(a.passwordEnc); } catch (err) { needsPassword = err instanceof DecryptError; }
  return {
    id: 'imap:' + a.id, email: a.email, type: 'imap',
    label: imapAccountLabel(a), provider: a.provider,
    imapHost: a.imapHost, smtpHost: a.smtpHost,
    needsPassword,
  };
}

// GET /api/mail/providers — host presets for the "add mailbox" form.
router.get('/providers', (_req, res) => {
  res.json({
    providers: Object.entries(mailbox.PROVIDERS).map(([key, p]) => ({ key, ...p })),
  });
});

// GET /api/mail/accounts — every connected mailbox, Gmail + IMAP, unified shape.
// Employees only get the mailboxes in EMPLOYEE_VISIBLE_EMAILS (Gmail excluded).
router.get('/accounts', async (req, res) => {
  try {
    const admin = isAdmin(req);
    const [gaccts, maccts] = await Promise.all([
      admin ? prisma.googleAccount.findMany({ select: { id: true, email: true } }) : Promise.resolve([]),
      prisma.mailAccount.findMany({ orderBy: { createdAt: 'asc' } }),
    ]);
    const visibleMaccts = admin ? maccts : maccts.filter((m) => EMPLOYEE_VISIBLE_EMAILS.has(m.email));
    const accounts = [
      ...gaccts.map((g) => ({ id: 'gmail:' + g.id, email: g.email, type: 'gmail', label: 'Gmail', provider: 'gmail' })),
      ...visibleMaccts.map(publicMailAccount),
    ];
    res.json({ accounts });
  } catch (err) {
    console.error('Mail accounts error:', err);
    res.status(500).json({ error: 'Could not load email accounts' });
  }
});

// POST /api/mail/accounts — add an IMAP/SMTP mailbox. Verifies the credentials
// by connecting before persisting, and stores the password encrypted at rest.
router.post('/accounts', requireAdmin, async (req, res) => {
  const { email, password, provider, label, imapHost, imapPort, smtpHost, smtpPort } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const prov = mailbox.PROVIDERS[provider] ? provider : 'godaddy';
  const hosts = mailbox.resolveHosts(prov, { imapHost, imapPort, smtpHost, smtpPort });
  if (!hosts.imapHost || !hosts.smtpHost) {
    return res.status(400).json({ error: 'IMAP and SMTP host are required for a custom provider' });
  }

  try {
    const existing = await prisma.mailAccount.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(409).json({ error: 'This mailbox is already connected' });

    // Verify credentials before persisting; a bad login here is a 400, not a 500.
    // Falls back to the sibling GoDaddy product when the picked one is rejected,
    // so we store the hosts that actually authenticated.
    let working;
    try {
      working = await mailbox.verifyImapWithFallback({
        provider: prov,
        overrides: { imapHost, imapPort, smtpHost, smtpPort },
        email: normalizedEmail,
        password,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const account = await prisma.mailAccount.create({
      data: {
        email: normalizedEmail,
        label: label ? String(label).trim() : null,
        provider: working.provider,
        imapHost: working.hosts.imapHost, imapPort: working.hosts.imapPort,
        smtpHost: working.hosts.smtpHost, smtpPort: working.hosts.smtpPort,
        passwordEnc: encrypt(password),
      },
    });
    res.status(201).json(publicMailAccount(account));
  } catch (err) {
    // The findUnique check above isn't atomic with the create() below — two
    // concurrent submits for the same address can both pass it, and the
    // loser hits this unique-constraint violation instead. Same outcome as
    // the early check, just report it the same way (409, not a generic 500).
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'This mailbox is already connected' });
    }
    console.error('Add mailbox error:', err);
    res.status(500).json({ error: 'Could not save the mailbox — try again' });
  }
});

// DELETE /api/mail/accounts/imap:<id> — remove an IMAP mailbox. (Gmail accounts
// are disconnected via /api/gmail/account.)
router.delete('/accounts/:id', requireAdmin, async (req, res) => {
  const m = /^imap:(\d+)$/.exec(req.params.id);
  if (!m) return res.status(400).json({ error: 'Use /api/gmail/account to disconnect a Gmail account' });
  const id = Number(m[1]);
  try {
    const acct = await prisma.mailAccount.findUnique({ where: { id } });
    if (!acct) return res.status(404).json({ error: 'Mailbox not found' });
    await prisma.mailAccount.delete({ where: { id } });
    res.json({ disconnected: true, email: acct.email });
  } catch (err) {
    console.error('Remove mailbox error:', err);
    res.status(500).json({ error: 'Could not remove the mailbox' });
  }
});

// GET /api/mail/recent — merged recent emails from all accounts, newest first.
// `view` picks which mailbox to read (inbox/starred/sent/spam/trash, default
// inbox). Each account is fetched independently; one failing (e.g. bad IMAP
// password) doesn't blank out the others — it's reported in `errors`.
// Employees only get mail from EMPLOYEE_VISIBLE_EMAILS (Gmail + hr@ excluded).
router.get('/recent', async (req, res) => {
  try {
  const admin = isAdmin(req);
  const perAccount = Math.min(Number(req.query.perAccount) || 20, 40);
  const view = MAIL_VIEWS.has(req.query.view) ? req.query.view : 'inbox';
  const [gacctsAll, macctsAll] = await Promise.all([
    admin ? prisma.googleAccount.findMany() : Promise.resolve([]),
    prisma.mailAccount.findMany({ orderBy: { createdAt: 'asc' } }),
  ]);
  const gaccts = gacctsAll;
  const maccts = admin ? macctsAll : macctsAll.filter((m) => EMPLOYEE_VISIBLE_EMAILS.has(m.email));
  if (gaccts.length === 0 && maccts.length === 0) {
    return res.status(400).json({ error: 'No email account connected. Add one in Settings.' });
  }

  const tasks = [
    ...gaccts.map((g) => async () => {
      const { emails } = await gmailClient.fetchRecent(g, { maxResults: perAccount, labelIds: GMAIL_VIEW_LABELS[view] });
      return emails.map((e) => ({
        ...e, id: 'gmail:' + g.id + ':' + e.id,
        account: g.email, accountType: 'gmail', accountId: 'gmail:' + g.id,
      }));
    }),
    ...maccts.map((m) => async () => {
      const password = unlock(m);
      const creds = { imapHost: m.imapHost, imapPort: m.imapPort, email: m.email, password };
      const emails = view === 'inbox' ? await mailbox.fetchRecent(creds, perAccount)
        : view === 'starred' ? await mailbox.fetchStarred(creds, perAccount)
        : await mailbox.fetchFolder(creds, view, perAccount);
      return emails.map((e) => ({
        id: `imap:${m.id}:${view}:${e.uid}`,
        subject: e.subject, from: e.from, to: e.to, date: e.date,
        body: e.body, bodyHtml: e.bodyHtml, unread: e.unread, starred: e.starred,
        attachments: e.attachments || [],
        // IMAP has no server-side conversation id, so the client threads these
        // from the RFC 822 headers instead. See conversationsOf() in the dashboard.
        messageId: e.messageId, inReplyTo: e.inReplyTo, references: e.references || [],
        account: m.email, accountType: 'imap', accountId: 'imap:' + m.id,
      }));
    }),
  ];

  const settled = await Promise.allSettled(tasks.map((t) => t()));
  const data = [];
  const errors = [];
  settled.forEach((r) => {
    if (r.status === 'fulfilled') data.push(...r.value);
    else errors.push(r.reason?.message || 'A mailbox failed to load');
  });
  data.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ data, errors });
  } catch (err) {
    console.error('Mail recent error:', err);
    res.status(500).json({ error: 'Could not load the inbox — try again' });
  }
});

// By default mailparser rewrites every `cid:` image reference in the HTML into
// an inline data: URI — right for showing a message in the dashboard, wrong for
// forwarding one: Gmail and Outlook strip data: images out of received mail, so
// the photo would break all over again. Keeping the cid links means the images
// go back out as real inline MIME parts, which every client renders.
const PARSE_FOR_FORWARD = { keepCidLinks: true };

// Access check + raw fetch + parse for one message the caller already has
// permission to read. Returns mailparser's full parse, inline parts included —
// unlike the list view, which hides cid: images so they don't show up as
// attachment chips on an email that visibly has none.
async function loadOriginalMessage(req, id) {
  const parsed = parseMailId(id);
  if (!parsed) return null;
  const { type, acctId, view, msgPart } = parsed;
  const admin = isAdmin(req);

  if (type === 'gmail') {
    if (!admin) throw Object.assign(new Error('Not allowed'), { status: 403 });
    const gacct = await prisma.googleAccount.findUnique({ where: { id: acctId } });
    if (!gacct) return null;
    return simpleParser(await gmailClient.getRawMessage(gacct, msgPart), PARSE_FOR_FORWARD);
  }

  const acct = await prisma.mailAccount.findUnique({ where: { id: acctId } });
  if (!acct) return null;
  if (!admin && !EMPLOYEE_VISIBLE_EMAILS.has(acct.email)) {
    throw Object.assign(new Error('Not allowed'), { status: 403 });
  }
  const password = unlock(acct);
  const raw = await mailbox.fetchRawMessage(
    { imapHost: acct.imapHost, imapPort: acct.imapPort, email: acct.email, password }, msgPart, view,
  );
  return simpleParser(raw, PARSE_FOR_FORWARD);
}

// POST /api/mail/send — send from a chosen account. accountId like "gmail:1" or
// "imap:2"; if omitted/unknown, falls back to the first Gmail account (admins
// only — employees must name an EMPLOYEE_VISIBLE_EMAILS mailbox explicitly).
// `forwardOf` is a message id: the original is re-read here and sent as the
// body, so its HTML, embedded photos and attachments all survive the forward.
router.post('/send', async (req, res) => {
  const { accountId, to, subject, body, attachments, forwardOf, replyOf } = req.body || {};
  // A forward carries the original message as its content, so the typed note
  // is allowed to be empty — everything else still needs a body.
  if (!to || !subject || (!body && !forwardOf)) {
    return res.status(400).json({ error: 'to, subject, and body are required' });
  }

  const admin = isAdmin(req);
  const parsed = /^(gmail|imap):(\d+)$/.exec(accountId || '');
  const type = parsed ? parsed[1] : null;
  const numId = parsed ? Number(parsed[2]) : null;

  if (!admin && type === 'gmail') {
    return res.status(403).json({ error: 'Not allowed to send from this account' });
  }

  try {
    let text = body || '';
    let html = null;
    let parts = normalizeAttachments(attachments);
    let threading = {};

    // Both re-read the original server-side and quote its real HTML. Quoting the
    // plain-text rendering client-side is what turned images and links into bare
    // URLs; see buildQuotedMessage.
    if (forwardOf || replyOf) {
      const original = await loadOriginalMessage(req, forwardOf || replyOf);
      if (!original) return res.status(404).json({ error: 'Original message not found' });
      const built = forwardOf ? buildForward(original, body || '') : buildReply(original, body || '');
      text = built.text;
      html = built.html;
      parts = parts.concat(built.attachments);
      // Keyed off references, not inReplyTo: a forward sets only the former.
      if (built.references) {
        threading = { references: built.references, ...(built.inReplyTo ? { inReplyTo: built.inReplyTo } : {}) };
      }
    }

    if (type === 'imap') {
      const acct = await prisma.mailAccount.findUnique({ where: { id: numId } });
      if (!acct) return res.status(404).json({ error: 'Sending mailbox not found' });
      if (!admin && !EMPLOYEE_VISIBLE_EMAILS.has(acct.email)) {
        return res.status(403).json({ error: 'Not allowed to send from this account' });
      }
      const password = unlock(acct);
      const messageId = await mailbox.sendSmtp(
        { smtpHost: acct.smtpHost, smtpPort: acct.smtpPort, email: acct.email, password },
        { to, subject, body: text, html, attachments: parts, ...threading },
      );
      return res.json({ message: 'Email sent', messageId, from: acct.email });
    }

    if (!admin) return res.status(403).json({ error: 'Not allowed to send from this account' });
    let gacct = type === 'gmail' ? await prisma.googleAccount.findUnique({ where: { id: numId } }) : null;
    if (!gacct) gacct = await prisma.googleAccount.findFirst();
    if (!gacct) return res.status(400).json({ error: 'No sending account available' });
    const messageId = await gmailClient.sendMessage(gacct, { to, subject, body: text, html, attachments: parts, ...threading });
    return res.json({ message: 'Email sent', messageId, from: gacct.email });
  } catch (err) {
    console.error('Mail send error:', err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// A Gmail token missing gmail.modify answers 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT.
// Nothing server-side can fix that — the account holder has to re-grant the
// scope — so it's the one failure the dashboard surfaces as actionable.
function isInsufficientScope(type, err) {
  return type === 'gmail' && (err.status === 403 || err.code === 403) && /scope|insufficient/i.test(err.message || '');
}

// Runs a provider-flag-setting action and normalizes provider refusals into
// { ok:false }, not an HTTP error — the dashboard has already updated the row
// optimistically and only needs to know whether to warn about reconnecting.
async function runFlagAction(req, res, { gmail: gmailFn, imap: imapFn }) {
  const parsed = parseMailId(req.body?.id);
  if (!parsed) return res.status(400).json({ error: 'A message id is required' });
  const { type, acctId, view, msgPart } = parsed;
  const admin = isAdmin(req);
  if (!admin && type === 'gmail') return res.status(403).json({ error: 'Not allowed' });

  try {
    if (type === 'gmail') {
      const gacct = await prisma.googleAccount.findUnique({ where: { id: acctId } });
      if (!gacct) return res.status(404).json({ error: 'Account not found' });
      await gmailFn(gacct, msgPart);
      return res.json({ ok: true });
    }

    const acct = await prisma.mailAccount.findUnique({ where: { id: acctId } });
    if (!acct) return res.status(404).json({ error: 'Account not found' });
    if (!admin && !EMPLOYEE_VISIBLE_EMAILS.has(acct.email)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const password = unlock(acct);
    const creds = { imapHost: acct.imapHost, imapPort: acct.imapPort, email: acct.email, password };
    await imapFn(creds, msgPart, view);
    return res.json({ ok: true });
  } catch (err) {
    if (isInsufficientScope(type, err)) {
      console.error(
        '[mail] Gmail refused to update a message — this account was connected before the '
        + 'gmail.modify scope was requested. Reconnect Gmail in Settings to re-grant it.',
      );
      return res.json({ ok: false, needsReconnect: true });
    }
    console.error('Mail flag-action error:', err.message);
    return res.json({ ok: false, error: err.message });
  }
}

// POST /api/mail/read — set the read/unread state at the provider (Gmail's
// UNREAD label / IMAP's \Seen flag), so an opened (or re-marked-unread) email
// stays in sync across the inbox's 60s refetch and in the mailbox itself.
// `id` is the unified message id from /recent. `read` defaults to true so
// existing "mark as read on open" callers don't need to change.
router.post('/read', (req, res) => {
  const read = req.body?.read !== false;
  return runFlagAction(req, res, {
    gmail: (gacct, msgPart) => gmailClient.setRead(gacct, msgPart, read),
    imap: (creds, msgPart, view) => (read ? mailbox.markSeen(creds, msgPart, view) : mailbox.markUnseen(creds, msgPart, view)),
  });
});

// POST /api/mail/star — set/clear the starred state (Gmail's STARRED label /
// IMAP's \Flagged flag). Body: { id, starred }.
router.post('/star', (req, res) => {
  const starred = !!req.body?.starred;
  return runFlagAction(req, res, {
    gmail: (gacct, msgPart) => gmailClient.setStarred(gacct, msgPart, starred),
    imap: (creds, msgPart, view) => mailbox.setStarred(creds, msgPart, starred, view),
  });
});

// POST /api/mail/trash — move one message to Trash (Gmail's trash endpoint /
// IMAP move-to-Trash-folder). Recoverable, not a permanent delete. Body: { id }.
router.post('/trash', (req, res) => {
  return runFlagAction(req, res, {
    gmail: (gacct, msgPart) => gmailClient.trashMessage(gacct, msgPart),
    imap: (creds, msgPart, view) => mailbox.moveToTrash(creds, msgPart, view),
  });
});

// GET /api/mail/favicon — proxies a sender domain's favicon from DuckDuckGo's
// icon service. DuckDuckGo returns its generic "no icon" placeholder with a
// *valid* image body (even on a 404 status) for domains it can't resolve, so a
// plain <img onerror> in the browser never catches it — the placeholder just
// renders. We fetch it server-side instead, where the response is byte-
// inspectable, and turn "it's the placeholder" into a real empty 404 so the
// client's onerror fallback (a colored initial) fires correctly.
const FAVICON_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DDG_PLACEHOLDER_SIZE = 1478; // fixed byte size of DuckDuckGo's generic icon
const faviconCache = new Map();
const FAVICON_CACHE_MAX = 500;

router.get('/favicon', async (req, res) => {
  const domain = String(req.query.domain || '').toLowerCase();
  if (!FAVICON_DOMAIN_RE.test(domain)) return res.status(400).end();
  const cached = faviconCache.get(domain);
  if (cached) {
    if (!cached.ok) return res.status(404).end();
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.send(cached.buf);
  }
  try {
    const upstream = await fetch(`https://icons.duckduckgo.com/ip3/${domain}.ico`, { signal: AbortSignal.timeout(6000) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ok = upstream.ok && buf.length !== DDG_PLACEHOLDER_SIZE;
    if (faviconCache.size >= FAVICON_CACHE_MAX) faviconCache.clear();
    const contentType = upstream.headers.get('content-type') || 'image/x-icon';
    // Only remember a *confirmed* result (a real icon, or DDG's own placeholder).
    // A transient network/timeout failure must never get cached here — a burst
    // of concurrent avatar requests on first inbox load can easily time one
    // out, and caching that would blacklist the domain's logo forever until
    // the server restarts.
    if (ok) faviconCache.set(domain, { ok, buf, contentType });
    else if (upstream.ok) faviconCache.set(domain, { ok: false });
    if (!ok) return res.status(404).end();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(buf);
  } catch (_e) {
    // Network/timeout error — deliberately not cached, so the next request retries fresh.
    res.status(404).end();
  }
});

// GET /api/mail/attachment — download one attachment.
// emailId matches the unified message id from /recent: "gmail:<acctId>:<msgId>"
// or "imap:<acctId>:<uid>". Gmail also needs attId (the Gmail attachmentId).
router.get('/attachment', async (req, res) => {
  const { emailId, filename, attId, mime, download } = req.query;
  const parsed = parseMailId(emailId);
  if (!parsed || !filename) return res.status(400).json({ error: 'emailId and filename are required' });
  const { type, acctId, view, msgPart } = parsed;
  const admin = isAdmin(req);
  if (!admin && type === 'gmail') return res.status(403).json({ error: 'Not allowed' });

  // Images and PDFs render fine in-browser — show them inline unless the caller
  // explicitly wants a download. Anything else (docx, xlsx, zip…) still forces a
  // download since the browser can't display it anyway.
  const isPreviewable = (ct) => /^image\//.test(ct || '') || ct === 'application/pdf';

  const sendFile = (buf, name, contentType) => {
    const safe = String(name).replace(/["\r\n]/g, '');
    const disposition = (!download && isPreviewable(contentType)) ? 'inline' : 'attachment';
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${disposition}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  };

  // Everything below is inside one try/catch, including the pre-check DB read
  // just above the Gmail/IMAP branch — a transient Neon connection error on
  // that read used to reject outside any try/catch and crash the invocation
  // instead of returning a clean 500.
  try {
    if (!admin && type === 'imap') {
      const acct = await prisma.mailAccount.findUnique({ where: { id: acctId }, select: { email: true } });
      if (!acct || !EMPLOYEE_VISIBLE_EMAILS.has(acct.email)) return res.status(403).json({ error: 'Not allowed' });
    }

    if (type === 'gmail') {
      if (!attId) return res.status(400).json({ error: 'attId is required for Gmail attachments' });
      const gacct = await prisma.googleAccount.findUnique({ where: { id: acctId } });
      if (!gacct) return res.status(404).json({ error: 'Account not found' });
      const buf = await gmailClient.getAttachment(gacct, msgPart, String(attId));
      return sendFile(buf, filename, mime);
    }

    const acct = await prisma.mailAccount.findUnique({ where: { id: acctId } });
    if (!acct) return res.status(404).json({ error: 'Account not found' });
    const password = unlock(acct);
    const att = await mailbox.fetchAttachment(
      { imapHost: acct.imapHost, imapPort: acct.imapPort, email: acct.email, password }, msgPart, filename, view,
    );
    return sendFile(att.content, att.filename, att.contentType);
  } catch (err) {
    console.error('Attachment download error:', err);
    return res.status(err.status || 500).json({ error: err.status === 404 ? err.message : 'Could not download attachment' });
  }
});

module.exports = router;
