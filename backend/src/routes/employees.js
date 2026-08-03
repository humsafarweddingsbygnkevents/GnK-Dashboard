'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');
const { createCodeForAccount } = require('../lib/loginCode');

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

// DELETE /api/employees/:id — remove an abandoned/never-linked pending
// account. Only allowed while it has no bound Gmail, so a real account can
// never be deleted through this route (deactivate is the lever for those).
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    if (id === req.admin?.sub) return res.status(400).json({ error: "You can't delete your own account" });

    const account = await prisma.admin.findUnique({ where: { id } });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.googleId) return res.status(400).json({ error: 'This account is linked — deactivate it instead' });

    await prisma.admin.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
