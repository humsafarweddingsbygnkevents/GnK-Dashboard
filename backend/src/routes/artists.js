'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');

function parseNumber(value, name, { min, max, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (integer && !Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  if (min !== undefined && n < min) throw new Error(`${name} must be >= ${min}`);
  if (max !== undefined && n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

// Query params that can be given more than once (?category=A&category=B) —
// Express parses repeats into an array already; a single value arrives as a
// bare string, so normalize both shapes to an array here.
function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const ARTIST_SELECT = {
  id: true,
  category: true,
  name: true,
  phone: true,
  gender: true,
  place: true,
  agencyName: true,
  agencyPhone: true,
  budget: true,
  budgetNote: true,
  peopleTraveling: true,
  instagramLink: true,
  driveLink: true,
  techRider: true,
  additionalInfo: true,
};

// GET /api/artists
router.get('/', async (req, res) => {
  try {
    const { search, page = '1', limit = '50' } = req.query;
    const categories = toArray(req.query.category);
    const places = toArray(req.query.place);

    let parsedPage, parsedLimit;
    try {
      parsedPage = parseNumber(page, 'page', { min: 1, integer: true });
      parsedLimit = parseNumber(limit, 'limit', { min: 1, max: 200, integer: true });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const where = {};
    if (categories.length) where.category = { in: categories };
    if (places.length) {
      // Case-insensitive exact match against the canonical place values,
      // same approach as area matching in hotels.js.
      const allPlaces = await prisma.artist.findMany({ where: { place: { not: null } }, select: { place: true }, distinct: ['place'] });
      const matched = places.map((p) => {
        const match = allPlaces.find((a) => a.place.toLowerCase() === p.toLowerCase());
        return match ? match.place : p;
      });
      where.place = { in: matched };
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { agencyName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const skip = (parsedPage - 1) * parsedLimit;

    const [artists, total] = await Promise.all([
      prisma.artist.findMany({
        where,
        skip,
        take: parsedLimit,
        orderBy: [{ name: 'asc' }],
        select: ARTIST_SELECT,
      }),
      prisma.artist.count({ where }),
    ]);

    res.json({
      data: artists,
      meta: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/artists/categories — distinct artist types with counts, for the
// artist-type filter. Must stay above /:id so "categories" isn't parsed as an id.
router.get('/categories', async (_req, res) => {
  try {
    const grouped = await prisma.artist.groupBy({
      by: ['category'],
      _count: { _all: true },
      orderBy: { category: 'asc' },
    });

    res.json({ data: grouped.map((g) => ({ name: g.category, artistCount: g._count._all })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/artists/places — distinct base cities with counts, for the city filter.
router.get('/places', async (_req, res) => {
  try {
    const grouped = await prisma.artist.groupBy({
      by: ['place'],
      where: { place: { not: null } },
      _count: { _all: true },
      orderBy: { place: 'asc' },
    });

    res.json({ data: grouped.map((g) => ({ name: g.place, artistCount: g._count._all })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/artists/:id
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  try {
    const artist = await prisma.artist.findUnique({ where: { id }, select: ARTIST_SELECT });
    if (!artist) return res.status(404).json({ error: `Artist with id ${id} not found` });
    res.json(artist);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
