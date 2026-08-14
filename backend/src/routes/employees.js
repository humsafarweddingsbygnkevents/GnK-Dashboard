'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');
const { createCodeForAccount, normalizeLoginCode, verifyAccountLoginCode } = require('../lib/loginCode');
const { rateLimit } = require('../lib/rateLimit');

// Deleting an account is destructive (cascades its attendance history), so
// it's gated behind the requesting admin re-entering their own login code —
// rate-limited same as the login form itself to blunt brute-forcing it.
const deleteLimiter = rateLimit({ max: 10, windowMs: 15 * 60 * 1000 });

function publicAccount(a, selfId) {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role,
    active: a.active,
    bound: !!a.googleId,
    createdAt: a.createdAt,
    self: a.id === selfId,
  };
}

// GET /api/employees — list all accounts, admins and employees alike (never
// the code hash). Renamed conceptually to "accounts" but the route path is
// kept to avoid touching every caller for no functional gain.
router.get('/', async (req, res) => {
  try {
    const accounts = await prisma.admin.findMany({
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ data: accounts.map((a) => publicAccount(a, req.admin?.sub)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/employees — create an account (name + role only; Gmail binds on
// their first login). The generated code is returned in this response ONLY;
// we store just its hash.
router.post('/', async (req, res) => {
  try {
    const { name, role } = req.body || {};
    const cleanName = name ? String(name).trim() : '';
    if (!cleanName) return res.status(400).json({ error: 'Name required' });
    const cleanRole = role === 'admin' ? 'admin' : role === 'employee' ? 'employee' : null;
    if (!cleanRole) return res.status(400).json({ error: 'Choose Admin or Employee' });

    const { account, code } = await createCodeForAccount((data) =>
      prisma.admin.create({ data: { name: cleanName, role: cleanRole, ...data } }),
    );

    res.status(201).json({ account: publicAccount(account, req.admin?.sub), code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/employees/:id — rename / activate / deactivate. Works on any
// account (admin or employee); you can't deactivate yourself.
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const account = await prisma.admin.findUnique({ where: { id } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    if (req.body?.active === false && id === req.admin?.sub) {
      return res.status(400).json({ error: "You can't deactivate your own account" });
    }

    const data = {};
    if (req.body?.name !== undefined) data.name = req.body.name ? String(req.body.name).trim() : null;
    if (req.body?.active !== undefined) data.active = !!req.body.active;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });

    const updated = await prisma.admin.update({ where: { id }, data });
    res.json(publicAccount(updated, req.admin?.sub));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/employees/:id/reset-code — mint a new permanent code (old one
// stops working immediately). Same one-time-return rule as creation. Works
// on any account, including your own.
router.post('/:id/reset-code', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const account = await prisma.admin.findUnique({ where: { id } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { code } = await createCodeForAccount((data) =>
      prisma.admin.update({ where: { id }, data }),
    );

    res.json({ id, code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/employees/:id — remove an account, linked or not. Destructive
// (cascades the employee's attendance entries/unlocks AND their filed
// feedback reports — see the Admin relations in schema.prisma), so the
// requesting admin must confirm with their own permanent login code — same
// code they sign in with — to guard against a stray click.
router.delete('/:id', deleteLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    if (id === req.admin?.sub) return res.status(400).json({ error: "You can't delete your own account" });

    const code = normalizeLoginCode(req.body?.code);
    if (code.length !== 8) return res.status(400).json({ error: 'Enter your 8-character code to confirm' });

    const requester = await prisma.admin.findUnique({ where: { id: req.admin.sub } });
    if (!requester || !(await verifyAccountLoginCode(requester, code))) {
      return res.status(401).json({ error: 'Incorrect code' });
    }

    const account = await prisma.admin.findUnique({ where: { id } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    await prisma.admin.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
