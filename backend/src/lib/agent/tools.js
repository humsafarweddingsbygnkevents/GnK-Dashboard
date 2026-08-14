'use strict';

// Agent tools for Hwoli's first-reply workflow.
//
// Every tool has the signature  fn(args, ctx)  where:
//   args = the arguments the model supplied (untrusted — validated here)
//   ctx  = { clientId, prisma } injected by the orchestrator.
//
// clientId is ALWAYS taken from ctx, never from args — the agent cannot
// point a write at a different client (provenance forced server-side).
//
// Only logClientDetails writes. searchHotels / searchClientHistory are
// strictly read-only.

// ---------------------------------------------------------------------------
// Small coercion helpers (the model often sends numbers/dates as strings)
// ---------------------------------------------------------------------------

function toStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toFloat(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Title-cases each word ("jim corbett" -> "Jim Corbett") for free-text city
// values that don't need to match a specific City row (e.g. a client's
// preferred city, which may not be in our hotel database at all).
function titleCase(city) {
  const s = toStr(city);
  if (!s) return null;
  return s.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Resolves a case-insensitive, possibly multi-word city name (e.g. "jim
// corbett") to its canonical stored form ("Jim Corbett") by looking it up in
// the City table — naive capitalisation breaks multi-word names.
async function resolveCityName(prisma, city) {
  const s = toStr(city);
  if (!s) return null;
  const cities = await prisma.city.findMany({ select: { name: true } });
  const match = cities.find((c) => c.name.toLowerCase() === s.toLowerCase());
  return match ? match.name : s;
}

// ---------------------------------------------------------------------------
// searchHotels — read-only. Mirrors the filter semantics of GET /api/hotels
// but returns a compact, LLM-friendly summary.
// ---------------------------------------------------------------------------

async function searchHotels(args = {}, ctx) {
  const prisma = ctx.prisma;
  const where = {};

  const city = await resolveCityName(prisma, args.city);
  if (city) where.city = { name: city };

  const minRooms = toInt(args.minRooms);
  const maxRooms = toInt(args.maxRooms);
  if (minRooms !== null || maxRooms !== null) {
    where.roomCount = {};
    if (minRooms !== null) where.roomCount.gte = minRooms;
    if (maxRooms !== null) where.roomCount.lte = maxRooms;
  }

  const search = toStr(args.search);
  if (search) where.name = { contains: search, mode: 'insensitive' };

  const limit = clamp(toInt(args.limit) || 5, 1, 10);

  const rows = await prisma.hotel.findMany({
    where,
    take: limit,
    orderBy: [{ name: 'asc' }],
    select: {
      name: true,
      roomCount: true,
      website: true,
      contactPerson: true,
      contactNumber: true,
      contactEmail: true,
      apPlanSeasonRate: true,
      apPlanOffSeasonRate: true,
      extraPersonRate: true,
      buyoutPrice: true,
      guestCapacity: true,
      relationshipManager: true,
      city: { select: { name: true } },
    },
  });

  const hotels = rows.map((h) => ({
    name: h.name,
    city: h.city?.name || null,
    roomCount: h.roomCount,
    guestCapacity: h.guestCapacity,
    apPlanSeasonRate: h.apPlanSeasonRate,
    apPlanOffSeasonRate: h.apPlanOffSeasonRate,
    extraPersonRate: h.extraPersonRate,
    buyoutPrice: h.buyoutPrice,
    contactPerson: h.contactPerson,
    contactNumber: h.contactNumber,
    contactEmail: h.contactEmail,
    relationshipManager: h.relationshipManager,
    website: h.website,
  }));

  return { count: hotels.length, hotels };
}

// ---------------------------------------------------------------------------
// searchClientHistory — read-only. What do we already know about this client?
// ---------------------------------------------------------------------------

async function searchClientHistory(args = {}, ctx) {
  const prisma = ctx.prisma;

  const client = await prisma.client.findUnique({
    where: { id: ctx.clientId },
    include: { functions: { orderBy: { date: 'asc' } } },
  });

  const out = { client: client || null };

  const search = toStr(args.search);
  if (search) {
    const matches = await prisma.client.findMany({
      where: {
        id: { not: ctx.clientId },
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      },
      take: 5,
      select: { id: true, name: true, phone: true, email: true, status: true, preferredCity: true },
    });
    out.matches = matches;
  }

  return out;
}

// ---------------------------------------------------------------------------
// logClientDetails — THE ONLY write tool.
//
// Writes only the fields the model supplied. Never blanks an existing value.
// `notes` and `mustHaveFeatures` are merged/appended (never replaced) so we
// never lose earlier context. Single-valued prefs are overwritten only when
// the model supplies a different, explicit, non-empty value in this message.
// ---------------------------------------------------------------------------

// Decide what to do with a single-valued scalar field.
function planScalar(existing, incoming) {
  if (incoming === null) return { action: 'skip', reason: 'empty' };
  const existingStr = existing === null || existing === undefined ? '' : String(existing);
  if (!existingStr) return { action: 'set', value: incoming };
  if (String(existing) === String(incoming)) return { action: 'skip', reason: 'unchanged' };
  return { action: 'overwrite', value: incoming, from: existing };
}

// Append `incoming` to existing free-text notes without duplicating it.
function mergeNotes(existing, incoming) {
  if (!incoming) return null;
  if (!existing) return incoming;
  if (existing.toLowerCase().includes(incoming.toLowerCase())) return null; // already there
  return `${existing}\n${incoming}`;
}

// Merge a comma-separated feature list, de-duplicating case-insensitively.
function mergeFeatures(existing, incoming) {
  if (!incoming) return null;
  const have = (existing || '').split(',').map((s) => s.trim()).filter(Boolean);
  const haveLower = new Set(have.map((s) => s.toLowerCase()));
  let changed = false;
  for (const f of incoming.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!haveLower.has(f.toLowerCase())) {
      have.push(f);
      haveLower.add(f.toLowerCase());
      changed = true;
    }
  }
  return changed ? have.join(', ') : null;
}

async function logClientDetails(args = {}, ctx) {
  const prisma = ctx.prisma;
  const client = await prisma.client.findUnique({ where: { id: ctx.clientId } });
  if (!client) return { ok: false, error: `Client ${ctx.clientId} not found` };

  const data = {};
  const applied = {};

  // --- simple single-valued scalar fields ---
  const scalarFields = {
    name: toStr(args.name),
    preferredCity: titleCase(args.preferredCity),
    cateringPreference: toStr(args.cateringPreference),
    decorStyle: toStr(args.decorStyle),
    guestCount: toInt(args.guestCount),
    budgetLakhs: toFloat(args.budgetLakhs),
    weddingDate: toDate(args.weddingDate),
  };
  for (const [field, incoming] of Object.entries(scalarFields)) {
    const plan = planScalar(client[field], incoming instanceof Date ? incoming.toISOString() : incoming);
    if (plan.action === 'set' || plan.action === 'overwrite') {
      data[field] = incoming;
      applied[field] = plan.action === 'overwrite'
        ? { action: 'overwritten', from: client[field], to: incoming }
        : { action: 'set', to: incoming };
    } else if (incoming !== null) {
      applied[field] = { action: 'skipped', reason: plan.reason };
    }
  }

  // --- append-only text fields ---
  const newNotes = mergeNotes(client.notes, toStr(args.notes));
  if (newNotes !== null) { data.notes = newNotes; applied.notes = { action: 'appended' }; }

  const newFeatures = mergeFeatures(client.mustHaveFeatures, toStr(args.mustHaveFeatures));
  if (newFeatures !== null) { data.mustHaveFeatures = newFeatures; applied.mustHaveFeatures = { action: 'merged', to: newFeatures }; }

  if (Object.keys(data).length) {
    await prisma.client.update({ where: { id: ctx.clientId }, data });
  }

  // --- functions: one Client can have many (mehendi, sangeet, reception…) ---
  const functionResults = [];
  if (Array.isArray(args.functions)) {
    const existingFns = await prisma.clientFunction.findMany({ where: { clientId: ctx.clientId } });
    for (const raw of args.functions) {
      if (!raw || typeof raw !== 'object') continue;
      const type = toStr(raw.type) || 'wedding';
      const incoming = {
        date: toDate(raw.date),
        city: titleCase(raw.city),
        guestCount: toInt(raw.guestCount),
      };
      // match an existing function of the same type (case-insensitive)
      const match = existingFns.find((f) => f.type.toLowerCase() === type.toLowerCase());
      if (match) {
        const upd = {};
        for (const field of ['date', 'city', 'guestCount']) {
          const cur = match[field];
          const inc = incoming[field];
          if (inc === null) continue;
          const plan = planScalar(cur instanceof Date ? cur.toISOString() : cur,
                                  inc instanceof Date ? inc.toISOString() : inc);
          if (plan.action === 'set' || plan.action === 'overwrite') upd[field] = inc;
        }
        if (Object.keys(upd).length) {
          await prisma.clientFunction.update({ where: { id: match.id }, data: upd });
          functionResults.push({ type, action: 'updated', fields: Object.keys(upd) });
        } else {
          functionResults.push({ type, action: 'skipped', reason: 'no new values' });
        }
      } else {
        const created = await prisma.clientFunction.create({
          data: { clientId: ctx.clientId, type, ...incoming },
        });
        functionResults.push({ type, action: 'created', id: created.id });
      }
    }
  }

  return {
    ok: true,
    clientId: ctx.clientId,
    applied,
    functions: functionResults,
    noop: Object.keys(applied).length === 0 && functionResults.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Registry + descriptions injected into the system prompt
// ---------------------------------------------------------------------------

const TOOL_REGISTRY = {
  searchHotels,
  searchClientHistory,
  logClientDetails,
};

const TOOL_DESCRIPTIONS = `The client's identity (clientId) is attached automatically by the system on every call — you never pass it yourself.

1. searchHotels — READ ONLY
   Purpose: Find wedding hotels/venues in our database that fit what the client wants.
   Args (all optional): {
     "city": string,        // e.g. "Jim Corbett"
     "minRooms": number,    // smallest room count a hotel must offer
     "maxRooms": number,
     "search": string,      // text to match in the hotel name
     "limit": 1-10          // how many to return (default 5)
   }
   Returns: { "count", "hotels": [{ name, city, roomCount, guestCapacity,
              apPlanSeasonRate, apPlanOffSeasonRate, extraPersonRate, buyoutPrice,
              contactPerson, contactNumber, contactEmail, relationshipManager,
              website }] }

2. searchClientHistory — READ ONLY
   Purpose: See what we already know about this client and their saved functions.
   Args (optional): { "search": string }  // also look up other clients by name/phone/email
   Returns: { "client": { ...profile, functions: [...] }, "matches": [...] }

3. logClientDetails — WRITE (the only tool that changes data)
   Purpose: Save concrete details the client stated, onto their profile.
   Include ONLY fields the client actually mentioned in this message. Existing saved
   values are never blanked; "notes" and "mustHaveFeatures" are appended/merged, not replaced.
   Args (all optional): {
     "name": string,
     "preferredCity": string,
     "weddingDate": "YYYY-MM-DD",
     "guestCount": number,
     "budgetLakhs": number,
     "cateringPreference": string,   // e.g. "Vegetarian only"
     "decorStyle": string,           // e.g. "Floral, traditional"
     "mustHaveFeatures": string,     // comma-separated, e.g. "Poolside, valet parking"
     "notes": string,                // any other useful context
     "functions": [                  // one entry per event the client mentions
       { "type": "wedding|reception|mehendi|sangeet|...", "date": "YYYY-MM-DD", "city": string, "guestCount": number }
     ]
   }
   Returns: { "ok", "applied": {...}, "functions": [...] }  // summary of what was saved/skipped`;

module.exports = { TOOL_REGISTRY, TOOL_DESCRIPTIONS, searchHotels, searchClientHistory, logClientDetails };
