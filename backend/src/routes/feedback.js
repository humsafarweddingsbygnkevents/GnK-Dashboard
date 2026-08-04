'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');

function isAdmin(req) {
  return req.admin?.role === 'admin';
}

// Data URL only — "data:image/jpeg;base64,…" — matches what the client's
// canvas-compressed screenshot produces. 6M base64 chars ≈ 4.5MB decoded,
// generous headroom over the ~1600px/quality-0.8 JPEGs the client sends.
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/;
const MAX_IMAGE_LEN = 6_000_000;

function publicFeedback(f) {
  return {
    id: f.id,
    message: f.message,
    screen: f.screen,
    status: f.status,
    createdAt: f.createdAt,
    resolvedAt: f.resolvedAt,
    hasImage: !!f.image,
    employee: f.employee ? { id: f.employee.id, name: f.employee.name, email: f.employee.email } : undefined,
  };
}

// POST /api/feedback — anyone logged in (employee or admin) can flag an
// issue from wherever they hit it in the dashboard, optionally with a
// screenshot (already resized/compressed client-side to a data URL).
router.post('/', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Describe the issue before sending' });
    if (message.length > 2000) return res.status(400).json({ error: 'Keep it under 2000 characters' });
    const screen = req.body?.screen ? String(req.body.screen).trim().slice(0, 60) : null;

    let image = null;
    if (req.body?.image) {
      image = String(req.body.image);
      if (!IMAGE_DATA_URL_RE.test(image)) return res.status(400).json({ error: 'Attachment must be an image' });
      if (image.length > MAX_IMAGE_LEN) return res.status(400).json({ error: 'Image is too large' });
    }

    const created = await prisma.feedback.create({
      data: { employeeId: req.admin.sub, message, screen, image },
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    res.status(201).json({ data: publicFeedback(created) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/feedback — admins see everyone's; employees see only their own.
router.get('/', async (req, res) => {
  try {
    const where = isAdmin(req) ? {} : { employeeId: req.admin.sub };
    if (req.query.status === 'open' || req.query.status === 'resolved') where.status = req.query.status;

    const items = await prisma.feedback.findMany({
      where,
      include: { employee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ data: items.map(publicFeedback) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/feedback/summary — admin-only open count, polled for the sidebar
// badge and new-feedback toast. Everyone else gets a 0 rather than a 403 so
// the dashboard-home widget doesn't need role branching just to stay quiet.
// Registered before the /:id route below — Express matches path segments
// literally before params, but "summary" would still shadow a numeric id
// route if this were declared after it.
router.get('/summary', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.json({ data: { openCount: 0 } });
    const openCount = await prisma.feedback.count({ where: { status: 'open' } });
    res.json({ data: { openCount } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/feedback/:id — full record including the screenshot, if any.
// Kept out of the list endpoint above so a page of reports doesn't drag a
// pile of base64 images along with it — the image loads lazily on demand.
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    const f = await prisma.feedback.findUnique({
      where: { id },
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    if (!f) return res.status(404).json({ error: 'Feedback not found' });
    if (!isAdmin(req) && f.employeeId !== req.admin.sub) return res.status(403).json({ error: 'Not your report' });

    res.json({ data: { ...publicFeedback(f), image: f.image || null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/feedback/:id — admin-only, toggle open/resolved.
router.patch('/:id', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const status = req.body?.status === 'resolved' ? 'resolved' : req.body?.status === 'open' ? 'open' : null;
    if (!status) return res.status(400).json({ error: 'status must be "open" or "resolved"' });

    const existing = await prisma.feedback.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Feedback not found' });

    const updated = await prisma.feedback.update({
      where: { id },
      data: { status, resolvedAt: status === 'resolved' ? new Date() : null },
      include: { employee: { select: { id: true, name: true, email: true } } },
    });
    res.json({ data: publicFeedback(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
