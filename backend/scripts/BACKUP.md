# Manual DB backup (Neon branch)

The production database lives on Neon project `neon-green-horizon`
(`odd-glitter-50660959`), branch `main`. There is a second branch, `backup`,
that is a full copy of `main` frozen at whatever moment it was last refreshed.

**Nothing in the deployed app, a route, a webhook, or a cron ever touches the
`backup` branch.** The only way it changes is a human running
`refreshBackup.js` from their own machine with their own Neon API key. That's
the entire safety model — approval is enforced by the key never existing
anywhere the app can reach, not by a flag in code.

## One-time setup

1. Neon console (console.neon.tech) → your avatar → API Keys → generate a key
   named something like `gnk-backup-script`.
2. Export it in your shell (don't put it in `.env`, don't commit it):
   ```bash
   export NEON_API_KEY="your-key-here"
   ```

## Refreshing the backup

```bash
cd backend
node scripts/refreshBackup.js
```

- First run: no `backup` branch exists yet, so it creates one as a copy of
  `main`. No confirmation needed — there's nothing to overwrite.
- Every run after that: it warns you that it's about to overwrite whatever is
  currently in `backup`, and requires you to type `YES` before proceeding.
  Answering anything else aborts with the backup untouched.

Run this whenever you're confident the live data is in a good state you'd
want to fall back to — after a normal period of usage, not mid-incident.

## Restoring in an emergency

If `main` is ever wiped or corrupted:

1. Run `refreshBackup.js` — it prints the `backup` branch's connection
   string at the end (also visible any time in the Neon console under
   Branches → `backup` → Connection Details).
2. **Do not** point production at that string directly as a quick fix — it's
   the read-write endpoint of a side branch, not `main`. Instead, in the Neon
   console, use "Restore" on the `main` branch itself, sourcing from the
   `backup` branch. This resets `main`'s data to match `backup` while keeping
   `main`'s existing connection strings (so `DATABASE_URL` in Vercel/`.env`
   still works — no redeploy needed).
3. Confirm data looks right (`prisma studio` or a few `SELECT`s) before
   resuming normal traffic.

## Notes

- Free tier Neon branch storage is shared across branches — the `backup`
  branch consumes storage the same way `main` does. Nothing to worry about at
  this project's current size (a few hundred rows across all tables plus 100
  hotel records), but if the DB grows a lot, keep an eye on Neon's Usage tab.
- This is a *manual point-in-time snapshot*, not continuous replication. It
  only protects data as of whenever you last ran the script. Neon's own
  built-in point-in-time restore (History window, currently 6h on this
  project) still covers the gap between refreshes.
