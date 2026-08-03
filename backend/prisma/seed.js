#!/usr/bin/env node
'use strict';

// Seeds the Hotel table from the Jim Corbett rate/contact sheet the team
// maintains in Excel. Re-running this script wipes and reloads Hotel + City
// (idempotent) — it's the source of truth, not something the dashboard
// writes back to.
const { PrismaClient } = require('@prisma/client');
const XLSX = require('xlsx');
const path = require('path');

const prisma = new PrismaClient();

const SHEET_PATH = path.resolve(__dirname, '../data/corbett-hotel-sheet.xlsx');
const CITY_NAME = 'Jim Corbett';
const CITY_STATE = 'Uttarakhand';

// Column order in the source sheet (see Sheet1, row 1 headers).
const COLS = [
  'name', 'area', 'roomCount', 'website', 'contactPerson', 'contactDesignation',
  'contactNumber', 'contactEmail', 'contactPerson2', 'contactDesignation2',
  'contactNumber2', 'apPlanSeasonRate', 'apPlanOffSeasonRate',
  'extraPersonRate', 'buyoutPrice', 'guestCapacity', 'guestCapacityMax',
  'relationshipManager', 'calling',
];

// The sheet uses " " (non-breaking space) for empty cells, plus the
// occasional stray "___"/"." placeholder — all treated as blank.
function cleanCell(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/ /g, ' ').trim();
  if (!s || /^[_.]+$/.test(s)) return null;
  return s;
}

function toInt(v) {
  const s = cleanCell(v);
  if (s === null) return null;
  const n = parseInt(s, 10);
  return Number.isInteger(n) ? n : null;
}

function rowToHotel(cells) {
  const row = {};
  COLS.forEach((key, i) => { row[key] = cleanCell(cells[i]); });
  return {
    name: row.name,
    area: row.area,
    roomCount: toInt(row.roomCount),
    website: row.website,
    contactPerson: row.contactPerson,
    contactDesignation: row.contactDesignation,
    contactNumber: row.contactNumber,
    contactEmail: row.contactEmail,
    contactPerson2: row.contactPerson2,
    contactDesignation2: row.contactDesignation2,
    contactNumber2: row.contactNumber2,
    apPlanSeasonRate: row.apPlanSeasonRate,
    apPlanOffSeasonRate: row.apPlanOffSeasonRate,
    extraPersonRate: row.extraPersonRate,
    buyoutPrice: row.buyoutPrice,
    guestCapacity: row.guestCapacity,
    guestCapacityMax: toInt(row.guestCapacityMax),
    relationshipManager: row.relationshipManager,
    calling: row.calling,
    source: 'rate-sheet',
  };
}

function loadHotelRows() {
  const wb = XLSX.readFile(SHEET_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  // header:1 -> array-of-arrays, defval:null -> keep column positions stable
  // even when a trailing cell in a row is empty.
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const hotels = [];
  // Skip the header row. Stop treating a row as hotel data once the Property
  // Name column is blank — the sheet has a stray duplicate-name table further
  // down with data only in unrelated columns, which this naturally excludes.
  for (const cells of rows.slice(1)) {
    const name = cleanCell(cells[0]);
    if (!name) continue;
    hotels.push(rowToHotel(cells));
  }
  return hotels;
}

async function main() {
  console.log('=== GnK Hotel Seed (Jim Corbett) ===\n');

  await prisma.hotel.deleteMany();
  await prisma.city.deleteMany();

  const city = await prisma.city.create({ data: { name: CITY_NAME, state: CITY_STATE } });

  const hotels = loadHotelRows();
  console.log(`Seeding ${CITY_NAME} (${hotels.length} hotels)...`);

  let created = 0;
  const failures = [];
  for (const hotel of hotels) {
    try {
      await prisma.hotel.create({ data: { ...hotel, cityId: city.id } });
      created++;
    } catch (err) {
      failures.push({ name: hotel.name, reason: err.message });
      console.error(`  [FAIL] ${hotel.name}: ${err.message}`);
    }
  }

  console.log('\n=== Import Summary ===');
  console.log(`Cities:          1`);
  console.log(`Hotels imported: ${created}`);
  if (failures.length) {
    console.log(`Failed (${failures.length}):`);
    for (const f of failures) console.log(`  "${f.name}": ${f.reason}`);
  } else {
    console.log('No import failures.');
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('Seed failed:', e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { loadHotelRows, cleanCell };
