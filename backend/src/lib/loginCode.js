'use strict';

const crypto = require('crypto');

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

function hashLoginCode(code) {
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

module.exports = { CODE_ALPHABET, CODE_LENGTH, generateLoginCode, normalizeLoginCode, hashLoginCode, createCodeForAccount };
