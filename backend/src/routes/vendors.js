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

const VENDOR_SELECT = {
  id: true,
  categories: true,
  serviceDetail: true,
  company: true,
  personContactedName: true,
  primaryPhone: true,
  secondaryPhone: true,
  address: true,
  city: true,
  remark: true,
};

// GET /api/vendors
router.get('/', async (req, res) => {
  try {
    const { search, page = '1', limit = '50' } = req.query;
    const categories = toArray(req.query.category);
    const cities = toArray(req.query.city);

    let parsedPage, parsedLimit;
    try {
      parsedPage = parseNumber(page, 'page', { min: 1, integer: true });
      parsedLimit = parseNumber(limit, 'limit', { min: 1, max: 200, integer: true });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const where = {};
    if (categories.length) where.categories = { hasSome: categories };
    if (cities.length) {
      // Case-insensitive exact match against the canonical city values, same
      // approach as area matching in hotels.js.
      const allCities = await prisma.vendor.findMany({ where: { city: { not: null } }, select: { city: true }, distinct: ['city'] });
      const matched = cities.map((c) => {
        const match = allCities.find((v) => v.city.toLowerCase() === c.toLowerCase());
        return match ? match.city : c;
      });
      where.city = { in: matched };
    }
    if (search) {
      where.OR = [
        { company: { contains: search, mode: 'insensitive' } },
        { personContactedName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const skip = (parsedPage - 1) * parsedLimit;

    const [vendors, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        skip,
        take: parsedLimit,
        orderBy: [{ company: 'asc' }],
        select: VENDOR_SELECT,
      }),
      prisma.vendor.count({ where }),
    ]);

    res.json({
      data: vendors,
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

// GET /api/vendors/categories — distinct vendor categories with counts, for
// the category filter. Must stay above /:id so "categories" isn't parsed as
// an id. `categories` is an array column, so counts are tallied in JS rather
// than via groupBy (Prisma can't group by array element).
router.get('/categories', async (_req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({ select: { categories: true } });
    const counts = new Map();
    for (const { categories } of vendors) {
      for (const c of categories) counts.set(c, (counts.get(c) || 0) + 1);
    }
    const data = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, vendorCount]) => ({ name, vendorCount }));
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/vendors/cities — distinct cities with counts, for the city filter.
router.get('/cities', async (_req, res) => {
  try {
    const grouped = await prisma.vendor.groupBy({
      by: ['city'],
      where: { city: { not: null } },
      _count: { _all: true },
      orderBy: { city: 'asc' },
    });

    res.json({ data: grouped.map((g) => ({ name: g.city, vendorCount: g._count._all })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/vendors/:id
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  try {
    const vendor = await prisma.vendor.findUnique({ where: { id }, select: VENDOR_SELECT });
    if (!vendor) return res.status(404).json({ error: `Vendor with id ${id} not found` });
    res.json(vendor);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
