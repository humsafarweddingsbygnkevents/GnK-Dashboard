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

const HOTEL_SELECT = {
  id: true,
  name: true,
  area: true,
  roomCount: true,
  website: true,
  contactPerson: true,
  contactDesignation: true,
  contactNumber: true,
  contactEmail: true,
  contactPerson2: true,
  contactDesignation2: true,
  contactNumber2: true,
  apPlanSeasonRate: true,
  apPlanOffSeasonRate: true,
  extraPersonRate: true,
  buyoutPrice: true,
  guestCapacity: true,
  guestCapacityMax: true,
  relationshipManager: true,
  calling: true,
  notes: true,
  city: { select: { name: true } },
};

// GET /api/hotels
router.get('/', async (req, res) => {
  try {
    const {
      city,
      area,
      minRooms,
      maxRooms,
      minGuests,
      maxGuests,
      search,
      page = '1',
      limit = '20',
    } = req.query;

    let parsedMinRooms, parsedMaxRooms, parsedMinGuests, parsedMaxGuests, parsedPage, parsedLimit;
    try {
      if (minRooms !== undefined) parsedMinRooms = parseNumber(minRooms, 'minRooms', { min: 0, integer: true });
      if (maxRooms !== undefined) parsedMaxRooms = parseNumber(maxRooms, 'maxRooms', { min: 0, integer: true });
      if (minGuests !== undefined) parsedMinGuests = parseNumber(minGuests, 'minGuests', { min: 0, integer: true });
      if (maxGuests !== undefined) parsedMaxGuests = parseNumber(maxGuests, 'maxGuests', { min: 0, integer: true });
      parsedPage = parseNumber(page, 'page', { min: 1, integer: true });
      parsedLimit = parseNumber(limit, 'limit', { min: 1, max: 100, integer: true });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (parsedMinRooms !== undefined && parsedMaxRooms !== undefined && parsedMinRooms > parsedMaxRooms) {
      return res.status(400).json({ error: 'minRooms cannot be greater than maxRooms' });
    }
    if (parsedMinGuests !== undefined && parsedMaxGuests !== undefined && parsedMinGuests > parsedMaxGuests) {
      return res.status(400).json({ error: 'minGuests cannot be greater than maxGuests' });
    }

    const where = {};

    if (city) {
      // Case-insensitive exact match — resolve the canonical name from the
      // City table rather than naive capitalisation ("Jim Corbett", etc.).
      const allCities = await prisma.city.findMany({ select: { name: true } });
      const match = allCities.find((c) => c.name.toLowerCase() === city.toLowerCase());
      where.city = { name: match ? match.name : city };
    }
    if (area) {
      // Case-insensitive exact match, same approach as city above.
      const allAreas = await prisma.hotel.findMany({ where: { area: { not: null } }, select: { area: true }, distinct: ['area'] });
      const match = allAreas.find((a) => a.area.toLowerCase() === area.toLowerCase());
      where.area = match ? match.area : area;
    }
    if (parsedMinRooms !== undefined || parsedMaxRooms !== undefined) {
      where.roomCount = {};
      if (parsedMinRooms !== undefined) where.roomCount.gte = parsedMinRooms;
      if (parsedMaxRooms !== undefined) where.roomCount.lte = parsedMaxRooms;
    }
    if (parsedMinGuests !== undefined || parsedMaxGuests !== undefined) {
      where.guestCapacityMax = {};
      if (parsedMinGuests !== undefined) where.guestCapacityMax.gte = parsedMinGuests;
      if (parsedMaxGuests !== undefined) where.guestCapacityMax.lte = parsedMaxGuests;
    }
    if (search) {
      where.name = { contains: search };
    }

    const skip = (parsedPage - 1) * parsedLimit;

    const [hotels, total] = await Promise.all([
      prisma.hotel.findMany({
        where,
        skip,
        take: parsedLimit,
        orderBy: [{ name: 'asc' }],
        select: HOTEL_SELECT,
      }),
      prisma.hotel.count({ where }),
    ]);

    res.json({
      data: hotels,
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

// GET /api/hotels/areas — distinct localities (e.g. "Dhikuli", "Chhoi") with hotel counts,
// for the area filter. Must stay above /:id so "areas" isn't parsed as an id.
router.get('/areas', async (_req, res) => {
  try {
    const grouped = await prisma.hotel.groupBy({
      by: ['area'],
      where: { area: { not: null } },
      _count: { _all: true },
      orderBy: { area: 'asc' },
    });

    res.json({ data: grouped.map((g) => ({ name: g.area, hotelCount: g._count._all })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/hotels/:id
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id },
      select: { ...HOTEL_SELECT, city: { select: { id: true, name: true, state: true } } },
    });

    if (!hotel) return res.status(404).json({ error: `Hotel with id ${id} not found` });

    res.json(hotel);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
