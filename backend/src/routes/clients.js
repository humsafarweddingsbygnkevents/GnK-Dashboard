'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');
const { CATEGORIES, classifyMessage, upsertClientFromMessage } = require('../lib/agent/classifier');

// Fields allowed through PATCH — source and id are never updatable
const PATCHABLE = ['name', 'phone', 'email', 'weddingDate', 'preferredCity',
                   'guestCount', 'budgetLakhs', 'notes', 'status', 'category'];

const SOURCES = ['gmail', 'instagram', 'facebook', 'manual', 'whatsapp', 'test'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseIntField(value, name, { min, max } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    throw Object.assign(new Error(`${name} must be a whole number`), { status: 400 });
  }
  if (min !== undefined && n < min) throw Object.assign(new Error(`${name} must be at least ${min}`), { status: 400 });
  if (max !== undefined && n > max) throw Object.assign(new Error(`${name} looks too large`), { status: 400 });
  return n;
}

function parseFloatField(value, name, { min, max } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error(`${name} must be a number`), { status: 400 });
  }
  if (min !== undefined && n < min) throw Object.assign(new Error(`${name} must be at least ${min}`), { status: 400 });
  if (max !== undefined && n > max) throw Object.assign(new Error(`${name} looks too large`), { status: 400 });
  return n;
}

function parseDateField(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw Object.assign(new Error(`${name} must be a valid date (e.g. "2026-11-14")`), { status: 400 });
  }
  const year = d.getFullYear();
  const maxYear = new Date().getFullYear() + 10;
  if (year < 1950 || year > maxYear) {
    throw Object.assign(new Error(`${name} must be a real date (year between 1950 and ${maxYear})`), { status: 400 });
  }
  return d;
}

// Accepts +, digits, spaces, hyphens, parentheses; requires 7–15 actual
// digits. Rejects anything with letters or too few/many digits.
function parsePhoneField(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^[+()\-\s\d]+$/.test(raw)) {
    throw Object.assign(new Error(`${name} can only contain digits, spaces, and + - ( )`), { status: 400 });
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw Object.assign(new Error(`${name} must have 7 to 15 digits`), { status: 400 });
  }
  return raw;
}

// Validate and coerce body fields shared by POST and PATCH
function parseClientBody(body, requireName = false) {
  const result = {};

  if (requireName) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      throw Object.assign(new Error('name is required'), { status: 400 });
    }
  }
  if (body.name !== undefined) result.name = String(body.name).trim();
  if (body.phone !== undefined) result.phone = parsePhoneField(body.phone, 'Phone');
  if (body.email !== undefined) {
    const email = body.email ? String(body.email).trim() : null;
    if (email && !EMAIL_RE.test(email)) {
      throw Object.assign(new Error('Email must be a valid address (e.g. name@example.com)'), { status: 400 });
    }
    result.email = email ? email.toLowerCase() : null;
  }
  if (body.preferredCity !== undefined)
    result.preferredCity = body.preferredCity ? String(body.preferredCity).trim() : null;
  if (body.notes !== undefined) result.notes = body.notes ? String(body.notes).trim() : null;
  if (body.status !== undefined) result.status = body.status ? String(body.status).trim() : 'new';
  if (body.category !== undefined) {
    const cat = body.category ? String(body.category).trim() : null;
    if (cat !== null && !CATEGORIES.includes(cat)) {
      throw Object.assign(new Error(`category must be one of: ${CATEGORIES.join(', ')}`), { status: 400 });
    }
    result.category = cat;
  }

  if ('guestCount' in body)
    result.guestCount = parseIntField(body.guestCount, 'Guest count', { min: 1, max: 1000000 });
  if ('budgetLakhs' in body)
    result.budgetLakhs = parseFloatField(body.budgetLakhs, 'Budget', { min: 0, max: 100000 });
  if ('weddingDate' in body)
    result.weddingDate = parseDateField(body.weddingDate, 'Event date');

  return result;
}

// POST /api/clients
router.post('/', async (req, res) => {
  try {
    const data = parseClientBody(req.body, true);
    data.source = 'manual'; // always override — never trust the caller

    const client = await prisma.client.create({ data });
    return res.status(201).json(client);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients
router.get('/', async (req, res) => {
  try {
    const { status, source, category, channelUserId, search, page = '1', limit = '20' } = req.query;

    let parsedPage, parsedLimit;
    try {
      parsedPage  = Math.max(1, parseInt(page, 10)  || 1);
      parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      if (!Number.isFinite(parsedPage) || !Number.isFinite(parsedLimit)) throw new Error();
    } catch {
      return res.status(400).json({ error: 'page and limit must be positive integers' });
    }

    const where = {};
    if (status) where.status = status;
    if (source) where.source = source;
    if (category) where.category = category;
    if (channelUserId) where.channelUserId = channelUserId;
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const skip = (parsedPage - 1) * parsedLimit;

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        where,
        skip,
        take: parsedLimit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.client.count({ where }),
    ]);

    return res.json({
      data: clients,
      meta: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit),
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/summary — counts per source and per category, for the
// dashboard's Clients tabs. Must be declared before the /:id route.
router.get('/summary', async (_req, res) => {
  try {
    const [bySourceRaw, byCategoryRaw, total] = await Promise.all([
      prisma.client.groupBy({ by: ['source'], _count: { _all: true } }),
      prisma.client.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.client.count(),
    ]);
    const bySource = {};
    for (const row of bySourceRaw) bySource[row.source] = row._count._all;
    const byCategory = {};
    for (const row of byCategoryRaw) byCategory[row.category ?? 'uncategorized'] = row._count._all;
    return res.json({ total, bySource, byCategory });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/sync-inbox — backfill Clients from stored Instagram /
// Facebook messages that arrived before auto-triage existed (or while it was
// down). Classifies each sender with no Client record yet. Optionally scoped
// to one sender via body { platform, senderId }.
router.post('/sync-inbox', async (req, res) => {
  try {
    const { platform: onlyPlatform, senderId: onlySenderId } = req.body || {};
    const where = {};
    if (onlyPlatform) {
      if (!['instagram', 'facebook'].includes(onlyPlatform)) {
        return res.status(400).json({ error: 'platform must be "instagram" or "facebook"' });
      }
      where.platform = onlyPlatform;
      if (onlySenderId) where.senderId = String(onlySenderId);
    }

    const [messages, contacts, clients] = await Promise.all([
      prisma.message.findMany({ where, orderBy: { timestamp: 'asc' } }),
      prisma.messageContact.findMany(),
      prisma.client.findMany({
        where: { source: { in: ['instagram', 'facebook'] }, channelUserId: { not: null } },
        select: { source: true, channelUserId: true },
      }),
    ]);

    const haveClient = new Set(clients.map((c) => `${c.source}:${c.channelUserId}`));
    const contactName = new Map(contacts.map((c) => [`${c.platform}:${c.senderId}`, c.displayName]));

    // Group messages per sender; skip senders that already have a Client.
    const bySender = new Map();
    for (const m of messages) {
      const key = `${m.platform}:${m.senderId}`;
      if (haveClient.has(key)) continue;
      if (!bySender.has(key)) bySender.set(key, []);
      bySender.get(key).push(m);
    }

    const results = [];
    for (const [key, msgs] of bySender) {
      const [platform, senderId] = key.split(/:(.+)/);
      const latest = msgs[msgs.length - 1];
      // Classify on the sender's combined recent texts — a first message is
      // often just "Hi", while the real ask comes two bubbles later.
      const combined = msgs.map((m) => m.text).filter(Boolean).slice(-6).join('\n');
      const senderName = contactName.get(key) || latest.senderName || null;
      const result = await upsertClientFromMessage({
        source: platform,
        channelUserId: senderId,
        senderName,
        text: combined,
        timestamp: latest.timestamp,
      });
      if (result) {
        results.push({ platform, senderId, clientId: result.client.id, created: result.created,
                       category: result.client.category });
      }
    }

    return res.json({ synced: results.length, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/from-email — staff clicked "Save as client" on a Gmail
// email. Classifies subject+body and upserts by the sender's email address.
router.post('/from-email', async (req, res) => {
  try {
    const { from, subject, body } = req.body || {};
    if (!from || typeof from !== 'string') {
      return res.status(400).json({ error: 'from is required (e.g. "Name <a@b.com>" or "a@b.com")' });
    }
    const emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s<]+@[^\s>]+)/);
    const email = emailMatch ? emailMatch[1].trim().toLowerCase() : null;
    if (!email) return res.status(400).json({ error: 'Could not extract an email address from "from"' });
    const senderName = from.match(/^([^<]+)</)?.[1]?.trim() || null;

    const text = [subject ? `Subject: ${subject}` : '', body || ''].filter(Boolean).join('\n').slice(0, 4000);
    const result = await upsertClientFromMessage({
      source: 'gmail',
      channelUserId: email,
      senderName,
      text,
      timestamp: new Date(),
    });
    if (!result) return res.status(500).json({ error: 'Could not save client from email' });
    return res.status(result.created ? 201 : 200).json({ client: result.client, created: result.created });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  try {
    const client = await prisma.client.findUnique({
      where: { id },
      include: { functions: { orderBy: { date: 'asc' } } },
    });
    if (!client) return res.status(404).json({ error: `Client with id ${id} not found` });
    return res.json(client);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/clients/:id — for spam/junk auto-created profiles. ClientFunction
// rows cascade (onDelete: Cascade in the schema). Stored Messages are kept —
// deleting a client never deletes conversation history.
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  try {
    await prisma.client.delete({ where: { id } });
    return res.json({ deleted: true, id });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: `Client with id ${id} not found` });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/clients/:id
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  try {
    // Only pick patchable fields from the body — strip source, id, createdAt, etc.
    const allowed = {};
    for (const key of PATCHABLE) {
      if (key in req.body) allowed[key] = req.body[key];
    }

    const data = parseClientBody(allowed, false);
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const client = await prisma.client.update({
      where: { id },
      data,
    });
    return res.json(client);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'P2025') return res.status(404).json({ error: `Client with id ${id} not found` });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
