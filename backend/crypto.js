// ── AES-256-GCM ENCRYPTION (per-user API key vault) ───────────────────────────
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;        // GCM standard
const AUTH_TAG_LEN = 16;  // GCM standard

function getMasterKey() {
  const hex = process.env.MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('MASTER_KEY env var must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext using AES-256-GCM with the master key.
 * Returns: base64 string of [iv(12) | authTag(16) | ciphertext]
 */
function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt a base64 blob produced by encrypt().
 * Returns: plaintext string, or null on invalid input
 */
function decrypt(b64) {
  if (!b64) return null;
  try {
    const key = getMasterKey();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < IV_LEN + AUTH_TAG_LEN) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
    const ct = buf.subarray(IV_LEN + AUTH_TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { encrypt, decrypt };