# Inbox actions feature

Built from three handwritten/screenshot notes: an action toolbar inside an
open email (Forward, Reply, Star, Mark as unread, Delete), and an "Options"
control beside the "All conversations" / "Unread" rail tabs exposing Spam,
Trash, Sent, Starred.

---

## START HERE — status as of 2026-08-12

The first pass of this feature shipped with three faults, all reported after
using it. All three are fixed in the working tree. **None of it is committed or
pushed.** No database write happened at any point.

Uncommitted files:

```
M backend/src/lib/gmailClient.js
M backend/src/lib/mailbox.js
M backend/src/routes/mail.js
M dashboard/index.html
?? backend/src/lib/forward.js     (new)
?? inbox.md                        (this file)
```

| Reported fault | Real cause | Status |
|---|---|---|
| Forwarding a photo mail sent **links instead of the photos** | The draft quoted the message's plain-text body, where an HTML mail's images are already just URLs — and `/api/mail/send` could only emit `text/plain` regardless | Fixed, rewritten server-side. **Needs one live send to confirm.** |
| The "Options" rail control **was just text** — clicking did nothing | The dropdown was `position:absolute` inside `.hd-rail`, which is `overflow-x:auto`; a scroll container clips on both axes, so the menu rendered entirely outside it and was never visible | Fixed (`position:fixed`), verified statically |
| The action buttons **weren't properly built** | Bare icons strung along the header with no grouping and only slow native `title` tooltips | Rebuilt: grouped bar, instant hover labels, aria-labels, separator before Trash | 

Two further bugs found while in there, both fixed:

- `openCompose()` seeded each new draft with the *previous* draft's
  attachments — a reply could silently ship files from an unrelated message.
- Double-clicking Star raced two opposite API calls and settled on whichever
  the provider answered last, not what the icon showed.

### Do this next

The user asked to work through these **one at a time**. Suggested order, most
consequential first:

1. **Forward** — the only path that still needs eyes on it. Start the backend,
   open the dashboard, open a mail that has embedded photos and/or
   attachments, hit Forward, send it **to a throwaway address, not a client**.
   Confirm on the receiving side: photos render inline (not as links), any
   attachments arrived, and the "Forwarded message" header block looks right.
2. **Options dropdown** — click it; the menu should now appear below the rail.
   Check each of Starred / Sent / Spam / Trash loads, and that the button then
   shows that folder's own name and icon.
3. **Action buttons** — hover each icon (labels should appear instantly),
   then exercise Star, Mark as unread and Trash on a throwaway message.

Careful with 2 and 3: Star / Mark-unread / Delete mutate **real mail** in the
connected Gmail and GoDaddy accounts. There is no dry-run mode.

### What is *not* verified

No live click-through was ever run. The Chrome extension isn't connected in the
session that wrote this, and the dev server talks to the real connected
mailboxes, so clicking Delete/Star/Mark-unread for real would mutate real mail.
Everything below marked "verified" means static or offline verification only.

The forward round-trip test was run from a throwaway scratchpad script that
does **not** persist. To recreate it: build a message with `MailComposer`
carrying an inline `cid:` image plus a PDF → `simpleParser(raw, { keepCidLinks:
true })` → `buildForward()` → `gmailClient.buildRawMessage()` → re-parse the
output with `keepCidLinks: true` and assert the image is still referenced by
cid, arrives byte-identical, and no `data:` URI appears in the raw bytes.

---

## Frontend — `dashboard/index.html`

**Thread header action toolbar** (`hdThreadHtml()`): the actions live in one
grouped `.hd-thread-actions` bar — Star, Mark as unread, Forward, a hairline
separator, then Move to Trash, with Details/Reply as labelled buttons on the
end. Each icon-only button carries a `data-tip` hover label (the native `title`
tooltip takes ~1s and renders as an OS box, which left a row of bare icons
reading as unfinished) plus an `aria-label`. Mark-as-unread uses an open-
envelope icon so it isn't identical to the generic mail glyph; Trash gets a red
hover. Star clicks are guarded by `starBusyId` so a double-click can't race two
opposite calls and settle on the wrong state.

- **Forward** (`openForwardModal()`) — opens compose with a `Fwd:` subject and
  an empty note box. The draft carries only `forwardOf: <message id>`; the
  original's content is assembled server-side at send time (see "Forwarding"
  below). The compose window shows a read-only card summarising what's being
  forwarded. Nothing is re-downloaded through the browser.
- **Star** (`toggleSelectedStar()`) — toggles `e.starred`, calls
  `POST /api/mail/star`, reverts optimistically on failure. Removes the item
  from the cached Starred list immediately on unstar (rather than waiting for
  the next 60s refetch).
- **Mark as unread** (`markSelectedUnread()`) — sets `e.unread = true`,
  deselects, calls `forgetRead()` to drop it from the local
  "already opened" memory (`hw_inbox_read_<adminId>` in localStorage — without
  this, the existing read-state reconciliation would silently re-mark it read
  on the next refresh), then `POST /api/mail/read` with `{ read: false }`.
- **Delete** (`deleteSelectedEmail()`) — removes the row from whichever list
  is currently backing the view (`removeEmailFromCurrentView()`), then
  `POST /api/mail/trash`. Optimistic; shows an error toast on failure rather
  than trying to resurrect the row.

**Rail "More" dropdown** (`hdRailHtml()`): a third rail item beside "All
conversations" and "Unread", opening a menu with **Starred, Sent, Spam,
Trash**. `toggleRailMore()` / `closeRailMore()` hook into the existing
outside-click/Escape listener.

The menu is `position:fixed`, with coordinates computed from the button's rect
in `openRailMore()`. It was `position:absolute` and **never visible**: `.hd-rail`
is `overflow-x:auto`, and a scroll container clips on both axes (a `visible`
overflow computes to `auto` when the other axis isn't `visible`), so a menu
rendered 8px below the rail's bottom edge fell entirely outside it. Clicking
"Options" appeared to do nothing. It closes on scroll/resize since the
coordinates go stale. The button now carries a chevron, shows the selected
folder's own name and icon, and the items show a check on the active one.

- `MAIL_FOLDER_VIEWS` = `Set(['starred','sent','spam','trash'])`,
  `MAIL_FOLDER_LABELS` for display names.
- `selectInboxView(view)` now branches: folder views call
  `loadMailFolder(view)` (lazy-fetch, 60s cache, stored in
  `S.mailFolders[view] = { emails, fetchedAt, loading, errors }`); `all`/
  `unread` keep the existing `S.emails`/`loadGmail()` path untouched.
- `inboxEmailList()`, `inboxViewLabel()`, `hdListHtml()` all branch on
  whether the current view is a folder view or the merged inbox. Folder
  views show a loading spinner on first fetch.
- `emailRowHtml()`: in the Sent view, shows "To: `<recipient>`" instead of
  the sender (every Sent row is otherwise From:you and indistinguishable).
  Also now shows a small gold star icon on starred rows.

State added: `S.mailFolders` (null until first folder view is opened).

## Backend

**`backend/src/lib/mailbox.js`** (generic IMAP, via imapflow) — generalized
around a `view` concept (`inbox`/`starred`/`sent`/`spam`/`trash`):

- `findFolder(client, kind)` — resolves Sent/Trash/Spam by RFC 6154
  `SPECIAL-USE` flag first (`\Sent`/`\Trash`/`\Junk`), falling back to
  name-matching (`Sent Items`, `Deleted Items`, `Junk E-mail`, etc.) for
  providers that don't advertise it.
- `resolveViewPath(client, view)` — inbox/starred → `INBOX`; sent/spam/trash
  → resolved special-use folder (or `INBOX` if none found).
- `fetchMailboxMessages()` — shared fetch core; `flaggedOnly` mode searches
  `\Flagged` instead of taking the newest N (used for Starred).
- New exports: `fetchStarred`, `fetchFolder(kind)`, `markUnseen`,
  `setStarred`, `moveToTrash`. `fetchAttachment` and the flag setters now take
  a `view` param so they open the right folder for a message that isn't in
  INBOX.
- Starred search is scoped to INBOX only (not every folder) — deliberate
  scope call, cross-folder star search would be slow for little benefit on
  a shared support mailbox.

**`backend/src/lib/gmailClient.js`** — `fetchRecent` now takes `labelIds` to
scope the list (`INBOX`/`STARRED`/`SENT`/`SPAM`/`TRASH`); every returned
email now carries `starred`. Replaced `markRead` with `setRead(account, id,
read)` (bidirectional), added `setStarred()` and `trashMessage()` (Gmail's
own trash endpoint — recoverable for 30 days, not permanent).

**`backend/src/routes/mail.js`**:

- `parseMailId(id)` — Gmail ids are unchanged
  (`gmail:<acctId>:<messageId>`, stable across labels). IMAP ids now carry
  the view: `imap:<acctId>:<view>:<uid>`, because a UID is only unique
  *within* one mailbox and Sent/Spam/Trash are separate mailboxes from
  INBOX. Old 3-part IDs (no view) parse as `view: 'inbox'` for backward
  compatibility with anything already cached client-side.
- `GET /api/mail/recent?view=...` — merges across every connected account
  for the requested view; unknown/missing `view` defaults to `inbox`
  (unchanged default behavior).
- `runFlagAction()` — shared helper for the three flag-setting routes below;
  normalizes provider refusals to `{ ok: false }` instead of an HTTP error
  (the dashboard has already updated optimistically), and flags a Gmail
  token missing the `gmail.modify` scope as `needsReconnect` (same pattern
  the old `/read` route used).
- `POST /api/mail/read` — now accepts `{ id, read }`, `read` defaults to
  `true` (old callers that only send `id` are unaffected).
- `POST /api/mail/star` — `{ id, starred }`.
- `POST /api/mail/trash` — `{ id }`.
- `GET /api/mail/attachment` — updated to parse the new 4-part IMAP id and
  pass `view` through to `fetchAttachment`, so downloading an attachment
  from a Sent/Spam/Trash message opens the right folder.

## Forwarding (rewritten — the first version shipped broken)

The original implementation quoted the message's **plain-text** body into the
draft. The text rendering of an HTML mail replaces every embedded photo with a
bare URL, so recipients received a wall of links instead of the pictures, and
`/api/mail/send` could only emit `text/plain` anyway. It is now server-side:

- `POST /api/mail/send` accepts `forwardOf: <message id>`. The route re-reads
  that message (`gmailClient.getRawMessage` / `mailbox.fetchRawMessage`, both
  returning raw RFC 822) and parses it with **`simpleParser(raw, { keepCidLinks:
  true })`**. That flag matters: by default mailparser rewrites `cid:` image
  references into inline `data:` URIs — correct for displaying a message in the
  dashboard, wrong for forwarding one, because Gmail and Outlook strip `data:`
  images out of received mail.
- `backend/src/lib/forward.js` — `buildForward(parsed, note)` returns
  `{ text, html, attachments }`: the note, a Gmail-style forwarded-message
  header block, then the original's own HTML. Parts the body references by cid
  go back out `Content-Disposition: inline` with their Content-ID intact
  (detected via mailparser's `related` flag, the part's own disposition, *or* a
  `cid:` match in the HTML — some clients ship embedded images as plain
  attachments carrying a Content-ID). Refuses over 18MB of parts.
- `gmailClient.buildRawMessage` now uses nodemailer's `MailComposer` instead of
  hand-concatenated MIME, so it can emit `multipart/mixed > multipart/
  alternative > multipart/related` and base64 bodies. The hand-rolled builder
  was text/plain-only and wrote `Content-Transfer-Encoding: 7bit` over UTF-8
  bodies. `sendSmtp` takes `html` for the same reason.
- Attachments are normalised to one nodemailer shape (`normalizeAttachments`)
  so both senders build identical messages.

Round-trip tested offline (no network, no DB, nothing sent): compose an
original with an inline cid image + a PDF, forward it, re-parse the outgoing
bytes. The inline photo arrives byte-identical with a matching Content-ID, the
HTML still points at it by cid, no `data:` URI is emitted, and a non-ASCII
subject/body survives. Also verified through the SMTP path and for an original
whose Content-ID image sits outside a `multipart/related`.

## Verification performed

- `node --check` on all four edited/added backend files — passes.
- `npx prisma validate` — schema untouched, still valid.
- `require('./src/app.js')` — loads clean with the new routes mounted, no
  throw.
- Inline `<script>` block in `dashboard/index.html` extracted and
  `node --check`'d — passes.
- Offline forward round-trip (see "Forwarding" above) — all assertions pass,
  through both the Gmail raw-MIME and the SMTP builder.
- Static sweep of `dashboard/index.html`: every inline `onclick` resolves to a
  declared function, and every class the mail UI uses has a CSS rule. (The
  missing-CSS check is what the invisible dropdown would *not* have caught —
  its rules existed; a scroll container was clipping it.)
- **Not done**: live click-through in a browser — see "What is *not* verified"
  at the top of this file.

## Notes / scope calls

- "Delete" always means *move to Trash* (Gmail's own trash button
  semantics), never a permanent delete — consistent across every view,
  including when already viewing Trash.
- Reply/Forward/Star/Mark-unread/Delete work the same regardless of which
  view (Inbox/Starred/Sent/Spam/Trash) the open email came from.
- No backend write touches Prisma/the database — every new route is a
  provider (Gmail API / IMAP) call. `MailAccount`/`GoogleAccount` rows are
  only read, never written, by any of this.
- `openCompose()` used to seed a new draft with `S.compose?.attachments`,
  carrying the *previous* draft's files into the next one — a reply could
  silently ship attachments from an unrelated message. New drafts now start
  empty unless the caller passes attachments explicitly.
