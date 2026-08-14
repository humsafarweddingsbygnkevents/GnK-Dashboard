# Humsafar GnK Dashboard — working rules

Read this before running anything.

## Hard rules — ask first, every single time

1. **Never write to the database.** No inserts, updates, deletes, migrations,
   resets, or seeds without explicit permission in the current message. Reads
   are fine. See "The database is production" below — there is no safe copy.
2. **Never commit or push without being asked in that message.** "Looks good"
   or "check it" is not permission to push. `main` is the deploy branch, so a
   push ships to production immediately.
3. **Never answer your own confirmation question.** If you write "tell me if
   you'd rather X" — stop and wait for the reply. Asking and then proceeding
   anyway is worse than not asking.
4. **Permission does not carry over.** Approval for one command covers that
   command once. The next destructive action needs its own yes.

## The database is production

`backend/.env` → `DATABASE_URL` points at the **live Neon production database**
(`ep-young-mode-au2on1f8-pooler…/neondb`). The deployed Vercel app uses this
same database. There is no staging DB, no local DB, no dev copy. Anything you
run against `DATABASE_URL` hits real customer data.

Nothing in this repo automatically backs it up. Recovery means Neon
point-in-time restore, bounded by the plan's history retention window.

### Commands that destroy data — never run these

- `prisma migrate diff --shadow-database-url <url>` — **Prisma resets the
  shadow database**: it drops every table and replays migrations into it. On
  2026-08-06 this was run with the production URL as the shadow database and
  wiped the entire database (100 hotels, clients, attendance, feedback,
  messages, admins, connected mail accounts). It looks like a read-only
  inspection command. It is not.
- `prisma migrate reset` / `npm run db:reset` — drops and recreates everything.
- `prisma migrate dev` — can reset on drift. Use `migrate deploy` for applying
  migrations, and only when asked.
- `prisma db push` — silently alters the live schema.
- `npm run db:seed` — `prisma/seed.js` starts with `hotel.deleteMany()` and
  `city.deleteMany()`. It is a destructive reload, not an additive import.
- `backend/scripts/bootstrapAdmin.js` — writes an admin row. It refuses when
  any admin already exists, but it is still a write.

To compare migrations against the schema, read the SQL files and the schema
directly. Do not point a diff tool at a real database.

### Safe read-only access

Prisma auto-loads `backend/.env`, so this works with no extra setup:

```js
const { PrismaClient } = require('./backend/node_modules/@prisma/client');
```

Restrict yourself to `count`, `findMany`, `findUnique`, and `$queryRaw` with
`SELECT`. If a "check" needs to write, it is not a check — ask first.

## Interpreting empty tables

If core tables come back empty, treat it as **possible data loss you caused**
before any other explanation. Do not rationalise it as a fresh database,
a first-run state, or a bootstrap problem. Stop and say so immediately —
the recovery window is finite and shrinking.

## Deploy

- Vercel project `humsafar-gnk-dashboard`; `main` deploys to production.
- **Migrations are not applied on deploy.** `postinstall` only runs
  `prisma generate`. New migrations must be applied deliberately, with
  permission, via `prisma migrate deploy`.
- No test suite. Verification means: `node --check`, `prisma validate`,
  loading `app.js`, and reading the diff — not running anything against the DB.

## Project facts worth keeping

- **Email:** `humsafarweddingsbygnk.in` is on **GoDaddy Workspace (legacy)** —
  MX is `mailstore1.secureserver.net`, so IMAP/SMTP is `*.secureserver.net`,
  **not** Titan (`*.titan.email`). `verifyImapWithFallback` in
  `backend/src/lib/mailbox.js` retries the sibling GoDaddy product and stores
  whichever hosts actually authenticated.
- **Signup needs a connected Gmail account.** `sendMail` sends the access code
  through the `GoogleAccount` OAuth row. With no such row, signup returns
  502 "Could not send the code right now". First admin on an empty DB comes
  from `bootstrapAdmin.js`; connect Gmail in Settings straight after.
- **Hotel/City are read-only to the app.** No route writes them — the source
  of truth is `backend/data/corbett-hotel-sheet.xlsx` (100 hotels, Jim
  Corbett), loaded by `prisma/seed.js`. This is the only table that can be
  rebuilt from the repo; nothing else can.
- **`JWT_SECRET` and `MAIL_ENC_KEY` in `backend/.env` must byte-for-byte match
  Vercel Production's values**, because local dev reads/writes the same prod
  DB (see "The database is production" above). `JWT_SECRET` hashes login
  codes (`backend/src/lib/loginCode.js`) and `MAIL_ENC_KEY` encrypts mailbox
  passwords (`backend/src/lib/crypto.js`) — if local's value differs from
  prod's, anything hashed/encrypted in one environment fails to verify/decrypt
  in the other ("Incorrect code" on every code, or "Saved password can't be
  unlocked", depending on which side you're testing from). On 2026-08-14 this
  happened because local `.env` had a stale/placeholder `JWT_SECRET` and an
  empty `MAIL_ENC_KEY`.
  - Vercel marks both **write-only/sensitive** — `vercel env pull` and the
    dashboard both return them blank once set, so there is no way to
    programmatically re-sync local from prod. If they ever go out of sync
    again, get the current value from whoever set it (or from wherever it was
    first generated) and paste it into `backend/.env` by hand; there's no
    automated fix for this.
  - Never run `backend/scripts/bootstrapAdmin.js` or any other script that
    writes login-code/mailbox-password hashes against the prod DB from a
    machine whose `.env` might not match Vercel — the hash it writes is only
    verifiable by whichever `JWT_SECRET` computed it.

## Code search

Grep to find the exact file and line, then read only that slice with
`offset`/`limit`. Don't read whole files to locate something.
