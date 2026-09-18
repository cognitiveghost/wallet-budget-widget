const store = require('./store');

let crypto = null;

// Injected so tests need no Electron. main/index.js passes safeStorage.
function setCrypto(impl) {
  crypto = impl;
}

function api() {
  if (crypto) return crypto;
  crypto = require('electron').safeStorage;
  return crypto;
}

// The API returns 401 "invalid JWT format: expected 3 parts, got 1" for a
// malformed token. Checking the shape here turns a paste error into an
// immediate message instead of a silent empty dashboard.
function looksLikeJwt(s) {
  if (typeof s !== 'string') return false;
  const parts = s.trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function save(token) {
  const t = typeof token === 'string' ? token.trim() : token;
  if (!looksLikeJwt(t)) throw new Error('That does not look like a JWT API token.');
  if (!api().isEncryptionAvailable()) {
    throw new Error('OS encryption is unavailable, refusing to store the token.');
  }
  const blob = api().encryptString(t).toString('base64');
  store.save({ ...store.load(), token: blob });
}

function load() {
  const blob = store.load().token;
  if (!blob) return null;
  try {
    return api().decryptString(Buffer.from(blob, 'base64'));
  } catch {
    // Blob written by another OS user, or DPAPI keys rotated. Treat as absent
    // so the app re-prompts rather than wedging on an unreadable secret.
    return null;
  }
}

function clear() {
  store.save({ ...store.load(), token: null });
}

module.exports = { setCrypto, looksLikeJwt, save, load, clear };
