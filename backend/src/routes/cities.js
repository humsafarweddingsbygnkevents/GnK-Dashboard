'use strict';

const { Router } = require('express');

const router = Router();
const prisma = require('../lib/prisma');

// GET /api/cities
router.get('/', async (_req, res) => {
  try {
    const cities = await prisma.city.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        state: true,
        _count: { select: { hotels: true } },
      },
    });

    const data = cities.map(c => ({
      id: c.id,
      name: c.name,
      state: c.state,
      hotelCount: c._count.hotels,
    }));

    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
