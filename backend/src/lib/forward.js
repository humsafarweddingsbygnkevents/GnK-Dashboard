'use strict';

// Builds the outgoing content for a forwarded message from the parsed original.
//
// Why this exists: forwarding used to re-quote the message's plain-text body.
// The text rendering of an HTML mail replaces every embedded photo with a bare
// URL, so recipients received links where the pictures should have been. A
// forward has to carry the original's own HTML plus every MIME part, with
// inline images keeping their Content-ID so the cid: references inside that
// HTML still resolve on the other end.

// Gmail caps a whole message at 25MB and base64 inflates bytes by ~4/3, so
// about 18MB of raw parts is as much as will actually go out.
const MAX_FORWARD_BYTES = 18 * 1024 * 1024;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Both senders (Gmail raw-MIME and SMTP) take nodemailer-shaped attachments, so
// everything is converted to that one shape here: the dashboard posts
// { filename, mimeType, data: <base64> }, forwarded parts arrive from
// mailparser with Buffers.
function normalizeAttachments(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && (a.data || a.content))
    .map((a) => ({
      filename: a.filename || 'attachment',
      content: a.content || Buffer.from(a.data, 'base64'),
      contentType: a.contentType || a.mimeType || 'application/octet-stream',
    }));
}

// Splits a full HTML document into the parts a forward has to keep separate.
//
// Marketing mail is almost always a complete document, and its colours —
// backgrounds, buttons, and the whole @media(prefers-color-scheme:dark) block —
// live in <style> in the <head>, not in inline styles. Nesting that document
// inside a wrapper <div> means every client drops the <head>, so the forward
// arrives with the layout and images intact and all the colour gone: a
// black-background email turns up white. Hoisting the <style> into a real
// <head> of our own is what keeps it looking like the original.
//
// A fragment (a plain reply, or text converted to HTML) has no <body> and is
// passed through untouched.
function splitHtmlDocument(html) {
  const src = String(html || '');
  const body = /<body([^>]*)>([\s\S]*)<\/body>/i.exec(src);
  if (!body) return { head: '', bodyAttrs: '', body: src };
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(src);
  return {
    // <style> only — scripts and <title> have no business in a forwarded mail.
    head: ((head ? head[1] : '').match(/<style[\s\S]*?<\/style>/gi) || []).join('\n'),
    bodyAttrs: body[1] || '',
    body: body[2],
  };
}

// `parsed` is a mailparser result for the original message; `note` is whatever
// the user typed above it. `mode` is 'forward' or 'reply' — they differ only in
// the label block and in which parts travel along, so everything that actually
// preserves the original's appearance is shared.
//
// A reply used to quote `parsed.text` client-side instead. The text rendering of
// an HTML mail replaces every image and link with a bare URL, so replying to a
// newsletter produced a wall of tracking links where the message had been (and
// it was truncated at 500 characters on top of that).
function buildQuotedMessage(parsed, note = '', mode = 'forward') {
  const isReply = mode === 'reply';
  const headers = [
    ['From', parsed.from?.text || ''],
    ['Date', parsed.date ? parsed.date.toUTCString() : ''],
    ['Subject', parsed.subject || ''],
    ['To', parsed.to?.text || ''],
    ['Cc', parsed.cc?.text || ''],
  ].filter(([, v]) => v);

  // "On <date>, <sender> wrote:" — the line every mail client expects above a
  // quoted reply, and what threading views collapse on.
  const attribution = `On ${parsed.date ? parsed.date.toUTCString() : ''}, `
    + `${parsed.from?.text || 'the sender'} wrote:`;

  const originalText = (parsed.text || '').trim();
  const originalHtml = parsed.html
    || parsed.textAsHtml
    || (originalText ? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(originalText)}</pre>` : '');

  const doc = splitHtmlDocument(originalHtml);

  // The note and the Forwarded-message header sit in their own opaque white
  // band above the original. They used to inherit whatever the message set, so
  // on a dark email they were black text on black. The original then follows
  // unwrapped — no border or padding around it — so a full-width layout still
  // measures the same as it did in the sender's own mail.
  const label = isReply
    ? `<div style="color:#6b7280">${escapeHtml(attribution)}</div>`
    : `<div style="color:#6b7280">---------- Forwarded message ---------<br>`
      + headers.map(([k, v]) => `<b>${k}:</b> ${escapeHtml(v)}`).join('<br>')
      + `</div>`;

  const intro =
    `<div style="background:#ffffff;color:#3a4035;font-family:Arial,Helvetica,sans-serif;` +
    `font-size:13px;line-height:1.55;padding:12px 14px">` +
      (note.trim() ? `<div style="color:#1a1f16">${escapeHtml(note).replace(/\r?\n/g, '<br>')}</div><br>` : '') +
      label +
    `</div>`;

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `${doc.head}</head>` +
    `<body${doc.bodyAttrs}>${intro}${doc.body}</body></html>`;

  const text =
    (note.trim() ? note.trim() + '\n\n' : '') +
    (isReply
      ? attribution + '\n' + originalText.replace(/^/gm, '> ')
      : '---------- Forwarded message ---------\n'
        + headers.map(([k, v]) => `${k}: ${v}`).join('\n')
        + '\n\n' + originalText);

  // Every cid the body actually points at. mailparser's own `related` flag
  // comes from the MIME structure, and not every client wraps its embedded
  // images in a multipart/related — some ship them as plain attachments that
  // carry a Content-ID. Those still have to go back out inline or the
  // recipient gets a broken image icon where the photo was.
  const referencedCids = new Set(
    [...String(originalHtml).matchAll(/\bcid:([^'"\s>)]{1,256})/gi)].map((m) => m[1]),
  );

  let total = 0;
  const attachments = (parsed.attachments || []).map((a) => {
    const inline = !!a.cid && (a.related || a.contentDisposition === 'inline' || referencedCids.has(a.cid));
    return {
      filename: a.filename || (inline ? `image-${a.cid}` : 'attachment'),
      content: a.content,
      contentType: a.contentType || 'application/octet-stream',
      contentDisposition: inline ? 'inline' : 'attachment',
      inline,
      ...(inline ? { cid: a.cid } : {}),
    };
  // A forward carries everything. A reply keeps only the inline images the
  // quoted HTML points at — sending someone their own attachments back is
  // noise, but dropping the cid parts would leave broken images in the quote.
  }).filter((a) => (isReply ? a.inline : true))
    .map(({ inline, ...a }) => { total += a.content ? a.content.length : 0; return a; });

  if (total > MAX_FORWARD_BYTES) {
    throw Object.assign(
      new Error(`This message has too many attachments to ${isReply ? 'quote' : 'forward'} (over 18MB) — download them and attach manually`),
      { status: 413 },
    );
  }

  // Threading: without In-Reply-To/References a reply opens a new conversation
  // in the recipient's client instead of landing under the message it answers.
  const refs = [parsed.references, parsed.messageId].flat().filter(Boolean).join(' ');
  return {
    text,
    html,
    attachments,
    ...(isReply && parsed.messageId ? { inReplyTo: parsed.messageId, references: refs } : {}),
  };
}

function buildForward(parsed, note = '') {
  return buildQuotedMessage(parsed, note, 'forward');
}

function buildReply(parsed, note = '') {
  return buildQuotedMessage(parsed, note, 'reply');
}

module.exports = { buildForward, buildReply, normalizeAttachments, escapeHtml, MAX_FORWARD_BYTES };
