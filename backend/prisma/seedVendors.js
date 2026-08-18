#!/usr/bin/env node
'use strict';

// Seeds the Vendor table from the wedding-vendor contact sheet the team
// maintains in "Merged vendor list.xlsx" — one row per company, one column
// per service category. Re-running this script wipes and reloads Vendor
// (idempotent) — it's the source of truth, not something the dashboard
// writes back to. Mirrors prisma/seedArtists.js (Artist).
const { PrismaClient } = require('@prisma/client');
const XLSX = require('xlsx');
const path = require('path');

const prisma = new PrismaClient();

const SHEET_PATH = path.resolve(__dirname, '../data/vendor-list.xlsx');

// Column positions on "Sheet1". The five category columns (2-6) each carry
// the column header itself when the vendor just does that service, or a
// more specific free-text description (e.g. "DJ on wheels, Vintage
// cars,sfx") when the sheet has more detail — both cases mean "this vendor
// offers this category".
const COLUMNS = {
  company: 0,
  personContactedName: 1,
  primaryPhone: 7,
  secondaryPhone: 8,
  address: 9,
  city: 10,
  remark: 11,
};
const CATEGORY_COLUMNS = [
  { index: 2, label: 'Wedding Planner' },
  { index: 3, label: 'Décor' },
  { index: 4, label: 'Caterer' },
  { index: 5, label: 'DJ/Dhol' },
  { index: 6, label: 'Photographer' },
];

function cleanCell(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^[-_.]+$/.test(s)) return null;
  return s;
}

function rowToVendor(cells) {
  const get = (key) => cleanCell(cells[COLUMNS[key]]);

  const categories = [];
  const details = [];
  for (const { index, label } of CATEGORY_COLUMNS) {
    const cell = cleanCell(cells[index]);
    if (!cell) continue;
    categories.push(label);
    if (cell.toLowerCase() !== label.toLowerCase()) details.push(cell);
  }

  return {
    categories,
    serviceDetail: details.length ? details.join('; ') : null,
    company: get('company'),
    personContactedName: get('personContactedName'),
    primaryPhone: get('primaryPhone'),
    secondaryPhone: get('secondaryPhone'),
    address: get('address'),
    city: get('city'),
    remark: get('remark'),
    source: 'vendor-sheet',
  };
}

function loadVendorRows() {
  const wb = XLSX.readFile(SHEET_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  // header:1 -> array-of-arrays, defval:null -> keep column positions
  // stable even when a trailing cell in a row is empty.
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const vendors = [];
  for (const cells of rows.slice(1)) {
    const company = cleanCell(cells[COLUMNS.company]);
    if (!company) continue;
    vendors.push(rowToVendor(cells));
  }
  return vendors;
}

async function main() {
  console.log('=== GnK Vendor Seed ===\n');

  const vendors = loadVendorRows();
  console.log(`Loaded ${vendors.length} vendors.`);

  await prisma.vendor.deleteMany();

  let created = 0;
  const failures = [];
  for (const vendor of vendors) {
    try {
      await prisma.vendor.create({ data: vendor });
      created++;
    } catch (err) {
      failures.push({ company: vendor.company, reason: err.message });
      console.error(`  [FAIL] ${vendor.company}: ${err.message}`);
    }
  }

  console.log('\n=== Import Summary ===');
  console.log(`Vendors imported: ${created}`);
  if (failures.length) {
    console.log(`Failed (${failures.length}):`);
    for (const f of failures) console.log(`  "${f.company}": ${f.reason}`);
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

module.exports = { loadVendorRows, cleanCell };
