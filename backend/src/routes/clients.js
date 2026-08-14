'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');
const requireAdmin = require('../middleware/requireAdmin');
const { CATEGORIES, classifyMessage, upsertClientFromMessage } = require('../lib/agent/classifier');

// Fields allowed through PATCH — source, id and createdByName (set once, at
// creation, from the logged-in employee) are never updatable
const PATCHABLE = ['name', 'phone', 'email', 'weddingDate', 'preferredCity',
                   'guestCount', 'roomCount', 'budgetLakhs', 'notes', 'status', 'statusOther', 'category',
                   'preferredHotel', 'budgetHotelLakhs', 'budgetDecorLakhs', 'budgetEventsLakhs',
                   'checkInDate', 'checkOutDate', 'eventType', 'eventTypeOther', 'relationshipManager',
                   'enquirySource', 'enquirySourceOther', 'nextFollowUpAt'];

const SOURCES = ['gmail', 'instagram', 'facebook', 'manual', 'whatsapp', 'test'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Staff-facing pipeline stage: has this lead confirmed, is it still being
// worked, has it gone quiet, or is it dead. These are the only values the UI
// offers.
const STATUSES = ['confirmed', 'active', 'no-response', 'lost'];
// A follow-up date is owed on any lead that's still live.
const STATUSES_REQUIRING_FOLLOWUP = ['active', 'no-response'];
// Values from before the list was simplified (twice). The client drawer keeps
// an old record's status selected rather than silently re-bucketing it, and
// sends the whole form back on save — so writes must still accept these, or
// editing any other field on a legacy record would fail validation.
const LEGACY_STATUSES = ['new', 'closed', 'other', 'contacted', 'site-visit-scheduled', 'booked'];
const WRITABLE_STATUSES = [...STATUSES, ...LEGACY_STATUSES];
const EVENT_TYPES = ['wedding', 'birthday', 'anniversary', 'other'];
// How a manually-entered enquiry reached us.
// 'hotel' and 'other' both carry a free-text detail in enquirySourceOther —
// which hotel sent them, or where else the enquiry came from.
const ENQUIRY_SOURCES = ['phone', 'walkin', 'referral', 'hotel', 'other'];
const ENQUIRY_SOURCES_WITH_DETAIL = ['hotel', 'other'];

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

// Digits-only, with the Indian country code / trunk prefix stripped, so
// "+91 98765 43210", "098765 43210" and "9876543210" all compare equal —
// callers otherwise create the same person three times under one number.
function normalizePhoneDigits(raw) {
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// Throws a 409 if another client (excluding excludeId, on edits) already
// has a phone number that normalizes to the same digits. `db` is a Prisma
// client or transaction handle — see withPhoneLock below for why this needs
// to run inside a transaction rather than against `prisma` directly.
async function assertNoDuplicatePhone(db, phone, excludeId) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return;
  const existing = await db.client.findMany({
    where: { phone: { not: null }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true, phone: true },
  });
  const dup = existing.find(c => normalizePhoneDigits(c.phone) === digits);
  if (dup) {
    throw Object.assign(
      new Error(`A client with this phone number already exists: ${dup.name}`),
      { status: 409 }
    );
  }
}

// assertNoDuplicatePhone on its own is read-then-write: two requests for the
// same phone number can both pass the check before either has written its
// row, producing two clients for the same person. There's no DB-level unique
// constraint to fall back on either — phone numbers are deduped on normalized
// digits (see normalizePhoneDigits), not the raw stored string, so a plain
// column constraint wouldn't catch e.g. "+91 98765 43210" vs "9876543210".
// A Postgres advisory lock scoped to the transaction and keyed on the
// normalized digits closes the race without a schema change: two concurrent
// requests for the same number serialize on this lock, so the second one's
// duplicate check runs only after the first's write has committed. Requests
// for different numbers (or with no phone at all) never contend.
async function withPhoneLock(phone, fn) {
  const digits = phone ? normalizePhoneDigits(phone) : null;
  if (!digits) return prisma.$transaction((tx) => fn(tx));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${digits}))`;
    return fn(tx);
  });
}

// Validate and coerce body fields shared by POST and PATCH. `existing` is the
// client's current DB row on a PATCH (null on POST, where there is none yet)
// — used to validate fields against their current stored value when a
// partial update only supplies one side of a pair (status/nextFollowUpAt,
// checkInDate/checkOutDate).
function parseClientBody(body, requireCore = false, existing = null) {
  const result = {};

  if (requireCore) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      throw Object.assign(new Error('name is required'), { status: 400 });
    }
    if (!body.phone || !String(body.phone).trim()) {
      throw Object.assign(new Error('Phone is required'), { status: 400 });
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
  if (body.preferredHotel !== undefined)
    result.preferredHotel = body.preferredHotel ? String(body.preferredHotel).trim() : null;
  if (body.relationshipManager !== undefined)
    result.relationshipManager = body.relationshipManager ? String(body.relationshipManager).trim() : null;
  if (body.notes !== undefined) result.notes = body.notes ? String(body.notes).trim() : null;

  if (body.status !== undefined) {
    const status = body.status ? String(body.status).trim() : 'no-response';
    if (!WRITABLE_STATUSES.includes(status)) {
      // Only the current values are named — suggesting a legacy one would be
      // telling the caller to pick something the UI no longer offers.
      throw Object.assign(new Error(`status must be one of: ${STATUSES.join(', ')}`), { status: 400 });
    }
    result.status = status;
    if (status === 'other') {
      if (!body.statusOther || !String(body.statusOther).trim()) {
        throw Object.assign(new Error('Please describe the status when choosing "Other"'), { status: 400 });
      }
      result.statusOther = String(body.statusOther).trim();
    } else {
      result.statusOther = null;
    }

    if (STATUSES_REQUIRING_FOLLOWUP.includes(status)) {
      result.nextFollowUpAt = parseDateField(body.nextFollowUpAt, 'Next follow-up date');
      if (!result.nextFollowUpAt) {
        throw Object.assign(new Error('Next follow-up date is required when status is Active or No Response'), { status: 400 });
      }
    } else {
      // Not owed a follow-up at this stage — don't leave a stale date behind.
      result.nextFollowUpAt = null;
    }
  } else if ('nextFollowUpAt' in body) {
    result.nextFollowUpAt = parseDateField(body.nextFollowUpAt, 'Next follow-up date');
    // status isn't part of this update, so the invariant above didn't run —
    // re-check it here against the client's current (unchanged) status so a
    // follow-up-only PATCH can't null it out on an active/no-response lead.
    if (!result.nextFollowUpAt && existing?.status && STATUSES_REQUIRING_FOLLOWUP.includes(existing.status)) {
      throw Object.assign(new Error('Next follow-up date is required when status is Active or No Response'), { status: 400 });
    }
  }

  if (body.category !== undefined) {
    const cat = body.category ? String(body.category).trim() : null;
    if (cat !== null && !CATEGORIES.includes(cat)) {
      throw Object.assign(new Error(`category must be one of: ${CATEGORIES.join(', ')}`), { status: 400 });
    }
    result.category = cat;
  }

  if (body.eventType !== undefined) {
    const type = body.eventType ? String(body.eventType).trim() : null;
    if (type !== null && !EVENT_TYPES.includes(type)) {
      throw Object.assign(new Error(`eventType must be one of: ${EVENT_TYPES.join(', ')}`), { status: 400 });
    }
    result.eventType = type;
    if (type === 'other') {
      if (!body.eventTypeOther || !String(body.eventTypeOther).trim()) {
        throw Object.assign(new Error('Please describe the event type when choosing "Other"'), { status: 400 });
      }
      result.eventTypeOther = String(body.eventTypeOther).trim();
    } else {
      result.eventTypeOther = null;
    }
  }

  if (body.enquirySource !== undefined) {
    const src = body.enquirySource ? String(body.enquirySource).trim() : null;
    if (src !== null && !ENQUIRY_SOURCES.includes(src)) {
      throw Object.assign(new Error(`enquirySource must be one of: ${ENQUIRY_SOURCES.join(', ')}`), { status: 400 });
    }
    result.enquirySource = src;
    if (ENQUIRY_SOURCES_WITH_DETAIL.includes(src)) {
      const detail = body.enquirySourceOther ? String(body.enquirySourceOther).trim() : '';
      // 'Other' is meaningless without the detail; 'Hotel' already says enough
      // on its own, so naming the hotel stays optional.
      if (src === 'other' && !detail) {
        throw Object.assign(new Error('Please describe the enquiry source when choosing "Other"'), { status: 400 });
      }
      result.enquirySourceOther = detail || null;
    } else {
      result.enquirySourceOther = null;
    }
  }

  if ('guestCount' in body)
    result.guestCount = parseIntField(body.guestCount, 'Guest count', { min: 1, max: 1000000 });
  if ('roomCount' in body)
    result.roomCount = parseIntField(body.roomCount, 'Number of rooms', { min: 1, max: 100000 });
  if ('budgetLakhs' in body)
    result.budgetLakhs = parseFloatField(body.budgetLakhs, 'Budget', { min: 0 });
  if ('budgetHotelLakhs' in body)
    result.budgetHotelLakhs = parseFloatField(body.budgetHotelLakhs, 'Hotel budget', { min: 0 });
  if ('budgetDecorLakhs' in body)
    result.budgetDecorLakhs = parseFloatField(body.budgetDecorLakhs, 'Decor budget', { min: 0 });
  if ('budgetEventsLakhs' in body)
    result.budgetEventsLakhs = parseFloatField(body.budgetEventsLakhs, 'Events budget', { min: 0 });
  if ('weddingDate' in body)
    result.weddingDate = parseDateField(body.weddingDate, 'Event date');
  if ('checkInDate' in body)
    result.checkInDate = parseDateField(body.checkInDate, 'Check-in date');
  if ('checkOutDate' in body)
    result.checkOutDate = parseDateField(body.checkOutDate, 'Check-out date');

  // A PATCH updating only one of the pair still has to respect the other's
  // already-stored value, or e.g. moving checkOutDate earlier alone can
  // invert the stay against an unchanged checkInDate.
  const effectiveCheckIn = 'checkInDate' in body ? result.checkInDate : existing?.checkInDate ?? null;
  const effectiveCheckOut = 'checkOutDate' in body ? result.checkOutDate : existing?.checkOutDate ?? null;
  if (effectiveCheckIn && effectiveCheckOut && effectiveCheckOut < effectiveCheckIn) {
    throw Object.assign(new Error('Check-out date must be on or after the check-in date'), { status: 400 });
  }

  return result;
}

// POST /api/clients
router.post('/', async (req, res) => {
  try {
    const data = parseClientBody(req.body, true);
    data.source = 'manual'; // always override — never trust the caller

    const client = await withPhoneLock(data.phone, async (tx) => {
      await assertNoDuplicatePhone(tx, data.phone);

      // Record which logged-in employee created this profile.
      if (req.admin?.sub) {
        const employee = await tx.admin.findUnique({ where: { id: req.admin.sub }, select: { name: true, email: true } });
        data.createdByName = employee?.name || employee?.email || null;
      }

      return tx.client.create({ data });
    });
    return res.status(201).json(client);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients
router.get('/', async (req, res) => {
  try {
    const { status, source, category, eventType, channelUserId, search, page = '1', limit = '20' } = req.query;

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
    // `category` is the retired LLM-triage field — still accepted so older
    // links keep working, but the UI filters on eventType now.
    if (category) where.category = category;
    // 'none' picks out rows staff never set an event type on; a bare null
    // can't be expressed as a query-string value.
    if (eventType) where.eventType = eventType === 'none' ? null : eventType;
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
    const [bySourceRaw, byCategoryRaw, byEventTypeRaw, total] = await Promise.all([
      prisma.client.groupBy({ by: ['source'], _count: { _all: true } }),
      prisma.client.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.client.groupBy({ by: ['eventType'], _count: { _all: true } }),
      prisma.client.count(),
    ]);
    const bySource = {};
    for (const row of bySourceRaw) bySource[row.source] = row._count._all;
    // byCategory is retained for any older client still reading it; the UI
    // uses byEventType.
    const byCategory = {};
    for (const row of byCategoryRaw) byCategory[row.category ?? 'uncategorized'] = row._count._all;
    // Unset event types land under 'none', matching the filter value the list
    // route accepts for the same rows.
    const byEventType = {};
    for (const row of byEventTypeRaw) byEventType[row.eventType ?? 'none'] = row._count._all;
    return res.json({ total, bySource, byCategory, byEventType });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Both follow-up routes below are read-only derivations of Client rows —
// there is no separate Notification/Reminder table. A reminder is simply
// "status is active/no-response and nextFollowUpAt is due", so it disappears
// exactly when an RM saves the client with a later follow-up date (or moves
// it off active/no-response) — never on a timer, and never just because
// someone viewed it. Editing the remark alone, without pushing the date
// forward, deliberately leaves it in place.
// Relationship Manager is a free-text column: whoever files the client types a
// name, so one person lands in the data as "Arnav", "arnav" or "Arnav Khanna".
// Matching ownership by `equals` on the account's full name therefore only ever
// hit when someone typed it character for character — which nobody had, so
// every employee's reminder list came back empty however many clients were
// theirs. These are the spellings that count as the requester.
//
// Two accounts sharing a first name will share those clients. That is inherent
// to ownership being a typed name rather than a link to the account, and is the
// reason to move this field to a picker; it is not made worse by matching here.
async function requesterAliases(req) {
  if (!req.admin?.sub) return [];
  const admin = await prisma.admin.findUnique({
    where: { id: req.admin.sub },
    select: { name: true, email: true },
  });
  if (!admin) return [];
  const aliases = new Set();
  const add = (v) => { const s = String(v || '').trim(); if (s) aliases.add(s); };
  add(admin.name);
  if (admin.name) add(admin.name.trim().split(/\s+/)[0]); // "Arnav" for "Arnav Khanna"
  add(admin.email);
  if (admin.email) add(admin.email.split('@')[0]);
  return [...aliases];
}

// Narrows `where` to the clients the requester owns. Callers use it for an
// employee (who only ever sees their own) and for an admin asking for theirs.
async function scopeToOwnClients(req, where) {
  const aliases = await requesterAliases(req);
  if (aliases.length) where.relationshipManager = { in: aliases, mode: 'insensitive' };
  else where.id = -1; // no resolvable name -> never matches, empty result
}

function startOfDayUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// GET /api/clients/followups — clients owed a follow-up. With no `date`,
// returns everything due today or overdue (the persistent reminder set).
// With `date=YYYY-MM-DD`, returns only that calendar day's follow-ups — lets
// an admin check a particular future/past date rather than just "today".
// With `range=upcoming`, returns everything scheduled tomorrow or later — the
// forward-looking list. `date` wins if both are sent.
// Everyone sees every follow-up: the team is small enough that a client going
// unchased matters more than who owns it, and scoping employees to their own
// meant a client nobody had been assigned was invisible to all of them.
// `scope=mine` narrows to the requester's own for the dashboard panel.
router.get('/followups', async (req, res) => {
  try {
    const where = { status: { in: STATUSES_REQUIRING_FOLLOWUP } };

    const endOfToday = new Date(startOfDayUTC(new Date()).getTime() + 24 * 60 * 60 * 1000);

    if (req.query.date) {
      const day = parseDateField(req.query.date, 'date');
      if (!day) return res.status(400).json({ error: 'date must be a valid date' });
      const start = startOfDayUTC(day);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      where.nextFollowUpAt = { gte: start, lt: end };
    } else if (req.query.range === 'upcoming') {
      // Everything scheduled from tomorrow on. Deliberately disjoint from the
      // default due/overdue set (which is `< endOfToday`) so a client shows up
      // in exactly one of the two views and the counts never double-count.
      where.nextFollowUpAt = { gte: endOfToday };
    } else {
      where.nextFollowUpAt = { lt: endOfToday };
    }

    if (req.query.scope === 'mine') await scopeToOwnClients(req, where);

    const clients = await prisma.client.findMany({
      where,
      orderBy: { nextFollowUpAt: 'asc' },
      select: {
        id: true, name: true, phone: true, email: true, status: true, statusOther: true,
        relationshipManager: true, nextFollowUpAt: true, notes: true, preferredCity: true,
      },
    });

    const startOfToday = startOfDayUTC(new Date());
    const data = clients.map((c) => ({ ...c, overdue: c.nextFollowUpAt < startOfToday }));
    return res.json({ data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/managers — the names a client can be assigned to, for the
// Relationship Manager picker. It lives here rather than on the accounts route
// because that one is admin-only and employees fill this field too; it answers
// with names and nothing else, which is already what the client cards show.
// Typing the name by hand is what let one person become "Arnav", "arnav" and
// "Arnav Khanna" at once, none of which matched their account.
// Registered before /:id for the same reason /summary is.
router.get('/managers', async (req, res) => {
  try {
    const accounts = await prisma.admin.findMany({
      where: { active: true },
      select: { name: true, email: true },
      orderBy: { name: 'asc' },
    });
    // Deduped: the field holds a name, so two accounts sharing one are a single
    // choice here (and, unavoidably, a single owner as far as this column goes).
    const names = [...new Set(
      accounts.map((a) => (a.name || '').trim() || a.email).filter(Boolean),
    )];
    return res.json({ data: names });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/followups/summary — lightweight counts for the bell badge
// and the dashboard stat cards. Registered before /:id for the same reason
// /summary above is — Express would otherwise try to parse "followups" as an
// id.
router.get('/followups/summary', async (req, res) => {
  try {
    const isAdmin = req.admin?.role !== 'employee';
    const startOfToday = startOfDayUTC(new Date());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    const where = { status: { in: STATUSES_REQUIRING_FOLLOWUP }, nextFollowUpAt: { lt: endOfToday } };
    // Unscoped for everyone, exactly like /followups — the badge has to count
    // the same rows as the page it opens, or it points at an empty list.
    const [dueCount, overdueCount, byManagerRaw] = await Promise.all([
      prisma.client.count({ where }),
      prisma.client.count({ where: { ...where, nextFollowUpAt: { lt: startOfToday } } }),
      isAdmin
        ? prisma.client.groupBy({ by: ['relationshipManager'], where, _count: { _all: true } })
        : Promise.resolve([]),
    ]);
    const byManager = byManagerRaw
      .map((r) => ({ manager: r.relationshipManager || 'Unassigned', count: r._count._all }))
      .sort((a, b) => b.count - a.count);

    return res.json({ data: { dueCount, overdueCount, byManager } });
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
// deleting a client never deletes conversation history. Admin only: employees
// can create and edit clients but never remove a profile.
router.delete('/:id', requireAdmin, async (req, res) => {
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

    // Fetch the current row only when a partial update needs it to validate
    // a field against its already-stored counterpart (see parseClientBody).
    let existing = null;
    const needsExisting =
      (allowed.status === undefined && 'nextFollowUpAt' in allowed) ||
      (('checkInDate' in allowed) !== ('checkOutDate' in allowed));
    if (needsExisting) {
      existing = await prisma.client.findUnique({
        where: { id },
        select: { status: true, checkInDate: true, checkOutDate: true },
      });
      if (!existing) return res.status(404).json({ error: `Client with id ${id} not found` });
    }

    const data = parseClientBody(allowed, false, existing);
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const client = await withPhoneLock(data.phone, async (tx) => {
      if (data.phone) await assertNoDuplicatePhone(tx, data.phone, id);
      return tx.client.update({ where: { id }, data });
    });
    return res.json(client);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.code === 'P2025') return res.status(404).json({ error: `Client with id ${id} not found` });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
