'use strict';

const crypto = require('crypto');

// AES-256-GCM encryption for secrets stored at rest (currently IMAP/SMTP
// mailbox passwords). The 32-byte key is derived with scrypt from
// MAIL_ENC_KEY, falling back to JWT_SECRET so no new env var is strictly
// required — but setting a dedicated MAIL_ENC_KEY is recommended so rotating
// the JWT secret doesn't lock you out of stored mailbox passwords.
function key() {
  const secret = process.env.MAIL_ENC_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('MAIL_ENC_KEY or JWT_SECRET must be set to encrypt mailbox passwords');
  // Fixed salt: this is a key-stretch, not password storage — the secret is
  // already high-entropy, and a stable salt keeps decryption deterministic.
  return crypto.scryptSync(secret, 'humsafar-gnk-mail-enc-v1', 32);
}

// Returns "iv.tag.ciphertext", all base64 — self-describing and easy to store
// in a single TEXT column.
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
