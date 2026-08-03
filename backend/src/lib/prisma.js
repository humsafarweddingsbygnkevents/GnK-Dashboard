'use strict';

// Single shared PrismaClient for the whole process. Serverless functions can
// be invoked many times against the same warm instance; a client-per-module
// pattern (the old approach) would open a new DB connection pool on every
// route file, exhausting Postgres's connection limit fast. One client, reused
// everywhere, keeps a single pool per function instance.
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;

const prisma = globalForPrisma.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
