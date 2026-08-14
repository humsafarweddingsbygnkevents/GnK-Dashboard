'use strict';

const crypto = require('crypto');
const prisma = require('./prisma');

// No 0/O/1/I lookalikes — the code gets read out over chat or in person.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateLoginCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeLoginCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Pepper-keyed HMAC — the pepper lives only in env config, never in the DB,
// so a leaked `loginCodeHash` column alone isn't enough to brute-force real
// codes offline the way the old bare-SHA-256 scheme (hashLoginCodeLegacy,
// below) was. Falls back to JWT_SECRET so no new env var is strictly
// required, mirroring lib/crypto.js's key() pattern — but a dedicated
// LOGIN_CODE_PEPPER is recommended so rotating JWT_SECRET doesn't also
// invalidate every stored login code.
function pepper() {
  const secret = process.env.LOGIN_CODE_PEPPER || process.env.JWT_SECRET;
  if (!secret) throw new Error('LOGIN_CODE_PEPPER or JWT_SECRET must be set to hash login codes');
  return secret;
}

function hashLoginCode(code) {
  return crypto.createHmac('sha256', pepper()).update(normalizeLoginCode(code)).digest('hex');
}

// The original scheme (plain, unsalted SHA-256, no pepper) — kept ONLY so
// codes hashed before the pepper was introduced still verify. Never used to
// create new hashes; findAccountByLoginCode/verifyAccountLoginCode below
// upgrade a row to the new scheme the moment it verifies under this one.
function hashLoginCodeLegacy(code) {
  return crypto.createHash('sha256').update(normalizeLoginCode(code)).digest('hex');
}

// Generates a fresh code and writes its hash via `mutate` (create or update).
// Retries on a loginCodeHash unique-constraint collision (P2002) — vanishingly
// rare at 8 chars from a 32-char alphabet, but the column is unique so a
// retry loop is the correct response rather than a hard failure.
async function createCodeForAccount(mutate, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const code = generateLoginCode();
    const loginCodeHash = hashLoginCode(code);
    try {
      const account = await mutate({ loginCodeHash, codeUpdatedAt: new Date() });
      return { account, code };
    } catch (err) {
      if (err.code === 'P2002' && i < attempts - 1) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique login code');
}

// Looks an account up by login code the same way the old direct
// findUnique-by-hash call sites did — tries the current (peppered) scheme
// first; on a miss, falls back to the legacy scheme, and on a legacy match
// rewrites just that one row's loginCodeHash to the new scheme so it never
// needs the fallback again. If the migration write itself fails for any
// reason, the login still succeeds — self-healing on a later request isn't
// worth failing a correct login over.
async function findAccountByLoginCode(code) {
  const account = await prisma.admin.findUnique({ where: { loginCodeHash: hashLoginCode(code) } });
  if (account) return account;

  const legacyMatch = await prisma.admin.findUnique({ where: { loginCodeHash: hashLoginCodeLegacy(code) } });
  if (!legacyMatch) return null;

  return prisma.admin
    .update({ where: { id: legacyMatch.id }, data: { loginCodeHash: hashLoginCode(code) } })
    .catch(() => legacyMatch);
}

// Same migration behaviour as findAccountByLoginCode, but for confirming a
// code against an account already fetched by another key (employees.js's
// delete-confirmation, which looks the requester up by id, not by code).
async function verifyAccountLoginCode(account, code) {
  if (account.loginCodeHash === hashLoginCode(code)) return true;
  if (account.loginCodeHash !== hashLoginCodeLegacy(code)) return false;

  await prisma.admin
    .update({ where: { id: account.id }, data: { loginCodeHash: hashLoginCode(code) } })
    .catch(() => {});
  return true;
}

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  generateLoginCode,
  normalizeLoginCode,
  hashLoginCode,
  createCodeForAccount,
  findAccountByLoginCode,
  verifyAccountLoginCode,
};
