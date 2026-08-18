#!/usr/bin/env node
'use strict';

// Seeds the Artist table from the performer roster the team maintains in
// "Artist Data.xlsx" — one sheet per artist type. Re-running this script
// wipes and reloads Artist (idempotent) — it's the source of truth, not
// something the dashboard writes back to. Mirrors prisma/seed.js (Hotel).
const { PrismaClient } = require('@prisma/client');
const XLSX = require('xlsx');
const path = require('path');

const prisma = new PrismaClient();

const SHEET_PATH = path.resolve(__dirname, '../data/artist-data.xlsx');

// Column layout differs by sheet shape: singer-type sheets have no Gender
// column, DJ/Anchor sheets do (and split budget into a wedding + club/show
// rate), and Make up Artist has no agency or tech-rider columns at all.
// Mapped explicitly per sheet (keyed to the raw sheet title, spacing and
// all) rather than guessed positionally.
const SHEET_COLUMNS = {
  'Bollywood & Punjabi Singer ': { name: 0, phone: 1, place: 2, agencyName: 3, agencyPhone: 4, budget: 5, peopleTraveling: 6, instagramLink: 7, driveLink: 8, techRider: 9, additionalInfo: 10 },
  'Sufi Singer': { name: 0, phone: 1, place: 2, agencyName: 3, agencyPhone: 4, budget: 5, peopleTraveling: 6, instagramLink: 7, driveLink: 8, techRider: 9 },
  'Unplugged Singer ': { name: 0, phone: 1, place: 2, agencyName: 3, agencyPhone: 4, budget: 5, peopleTraveling: 6, instagramLink: 7, driveLink: 8, techRider: 9 },
  'Male DJ': { name: 0, phone: 1, gender: 2, place: 3, agencyName: 4, agencyPhone: 5, budget: 6, budgetNote: 7, instagramLink: 8, driveLink: 9, additionalInfo: 10 },
  'Female DJ': { name: 0, phone: 1, gender: 2, place: 3, agencyName: 4, agencyPhone: 5, budget: 6, budgetNote: 7, instagramLink: 8, driveLink: 9, additionalInfo: 10 },
  'Male Anchor ': { name: 0, phone: 1, gender: 2, place: 3, agencyName: 4, agencyPhone: 5, budget: 6, budgetNote: 7, instagramLink: 8, driveLink: 9, additionalInfo: 10 },
  'Female Anchor': { name: 0, phone: 1, gender: 2, place: 3, agencyName: 4, agencyPhone: 5, budget: 6, budgetNote: 7, instagramLink: 8, driveLink: 9, additionalInfo: 10 },
  // Column B on this sheet is headed "Artist Number" but actually holds the
  // band's headcount (e.g. "12", "10", "8"), not a phone number — there's no
  // individual artist phone for a band, only the manager/agency number.
  'DJ based Band': { name: 0, peopleTraveling: 1, gender: 2, place: 3, agencyName: 4, agencyPhone: 5, budget: 6, budgetNote: 7, instagramLink: 8, driveLink: 9, additionalInfo: 10 },
  'Mayra Singer': { name: 0, phone: 1, place: 2, agencyName: 3, agencyPhone: 4, budget: 5, peopleTraveling: 6, instagramLink: 7, driveLink: 8, techRider: 9 },
  'Make up Artist': { name: 0, phone: 1, place: 2, budget: 3, peopleTraveling: 4, instagramLink: 5, driveLink: 6 },
};

// Sheet titles carry stray trailing spaces ("Male Anchor ") — clean for the
// stored/displayed category while SHEET_COLUMNS above stays keyed to the raw title.
function cleanCategory(title) {
  return title.trim().replace(/\s+/g, ' ');
}

function cleanCell(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^[-_.]+$/.test(s)) return null;
  return s;
}

// The sheet records "where the artist is based" inconsistently — sometimes a
// single city, sometimes "Delhi/<city>" (their touring hub + home city), and
// with mixed casing ("Delhi/mumbai" vs "Delhi/Mumbai"). Collapse all known
// variants onto one canonical name so the city filter doesn't fragment into
// near-duplicates. Anything not listed here passes through as-is (trimmed).
const PLACE_ALIASES = {
  'delhi/dehradun': 'Dehradun',
  'dehradun': 'Dehradun',
  'delhi/gurgaon': 'Gurugram',
  'gurgaon': 'Gurugram',
  'gurugram': 'Gurugram',
  'delhi/jaipur': 'Jaipur',
  'jaipur': 'Jaipur',
  'delhi/mumbai': 'Mumbai',
  'mumbai': 'Mumbai',
  'delhi': 'Delhi',
  'new delhi': 'Delhi',
  'pune': 'Pune',
  'mumbai/pune': 'Pune',
  'faridabad (delhi ncr)': 'Faridabad',
  'faridabad': 'Faridabad',
};

function normalizePlace(v) {
  if (v === null) return null;
  return PLACE_ALIASES[v.toLowerCase()] || v;
}

// A handful of Insta/Drive links in the sheet are missing the protocol
// ("www.instagram.com/x", "tr.ee/x") — as-is those render as broken
// relative hrefs in the dashboard, so prepend https:// to anything that
// looks like a bare domain rather than free text.
function normalizeUrl(v) {
  if (v === null) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v)) return `https://${v}`;
  return v;
}

function rowToArtist(cells, cols, category) {
  const get = (key) => (cols[key] !== undefined ? cleanCell(cells[cols[key]]) : null);
  return {
    category,
    name: get('name'),
    phone: get('phone'),
    gender: get('gender'),
    place: normalizePlace(get('place')),
    agencyName: get('agencyName'),
    agencyPhone: get('agencyPhone'),
    budget: get('budget'),
    budgetNote: get('budgetNote'),
    peopleTraveling: get('peopleTraveling'),
    instagramLink: normalizeUrl(get('instagramLink')),
    driveLink: normalizeUrl(get('driveLink')),
    techRider: get('techRider'),
    additionalInfo: get('additionalInfo'),
    source: 'artist-sheet',
  };
}

function loadArtistRows() {
  const wb = XLSX.readFile(SHEET_PATH);
  const artists = [];
  for (const sheetName of wb.SheetNames) {
    const cols = SHEET_COLUMNS[sheetName];
    if (!cols) {
      console.warn(`  [SKIP] Unrecognized sheet "${sheetName}" — no column map, add one to SHEET_COLUMNS`);
      continue;
    }
    const ws = wb.Sheets[sheetName];
    // header:1 -> array-of-arrays, defval:null -> keep column positions
    // stable even when a trailing cell in a row is empty.
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const category = cleanCategory(sheetName);
    for (const cells of rows.slice(1)) {
      const name = cleanCell(cells[cols.name]);
      if (!name) continue;
      artists.push(rowToArtist(cells, cols, category));
    }
  }
  return artists;
}

async function main() {
  console.log('=== GnK Artist Seed ===\n');

  const artists = loadArtistRows();
  console.log(`Loaded ${artists.length} artists across ${new Set(artists.map((a) => a.category)).size} categories.`);

  await prisma.artist.deleteMany();

  let created = 0;
  const failures = [];
  for (const artist of artists) {
    try {
      await prisma.artist.create({ data: artist });
      created++;
    } catch (err) {
      failures.push({ name: artist.name, reason: err.message });
      console.error(`  [FAIL] ${artist.name}: ${err.message}`);
    }
  }

  console.log('\n=== Import Summary ===');
  console.log(`Artists imported: ${created}`);
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

module.exports = { loadArtistRows, cleanCell, cleanCategory, normalizePlace, normalizeUrl };
