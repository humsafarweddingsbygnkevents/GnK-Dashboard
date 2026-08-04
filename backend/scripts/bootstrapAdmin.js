#!/usr/bin/env node
'use strict';

// One-time bootstrap for a fresh deployment: creates the very first admin
// account directly in the database, sidestepping the normal signup flow
// (which emails the code via a connected Gmail account — but a brand new
// database has no Gmail account connected yet, so there's no way to send
// that first code). Run this once, log in with the printed code, then
// connect Gmail in Settings so the normal signup flow works for everyone
// else after that.
//
// Usage: node backend/scripts/bootstrapAdmin.js "Admin Name"

const { PrismaClient } = require('@prisma/client');
const { createCodeForAccount } = require('../src/lib/loginCode');

const prisma = new PrismaClient();

async function main() {
  const name = process.argv[2] ? String(process.argv[2]).trim() : 'Admin';
  if (!name) throw new Error('Usage: node backend/scripts/bootstrapAdmin.js "Admin Name"');

  const existing = await prisma.admin.count();
  if (existing > 0) {
    throw new Error(
      `Refusing to bootstrap — ${existing} admin account(s) already exist. ` +
      `Use the Team screen (or a new script) to add more accounts instead.`,
    );
  }

  const { account, code } = await createCodeForAccount((data) =>
    prisma.admin.create({ data: { name, role: 'admin', ...data } }),
  );

  console.log('\nAdmin account created:');
  console.log(`  Name: ${account.name}`);
  console.log(`  Role: ${account.role}`);
  console.log(`\nLogin code (permanent, shown only once — copy it now):\n\n  ${code}\n`);
  console.log('Log in with this code on the dashboard\'s "Log in" tab, then connect');
  console.log('Gmail in Settings so the normal signup flow works for everyone else.\n');
}

main()
  .catch((err) => {
    console.error('Bootstrap failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
