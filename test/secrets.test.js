const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../main/store');
const secrets = require('../main/secrets');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wbw-'));

// Stands in for Electron's safeStorage. Reversible, not secure — the point is
// that secrets.js round-trips through whatever it is given.
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};

const JWT = 'aaa.bbb.ccc';

test('a three-part token is recognised as a JWT', () => {
  assert.strictEqual(secrets.looksLikeJwt(JWT), true);
});

test('a token with the wrong number of parts is rejected', () => {
  assert.strictEqual(secrets.looksLikeJwt('nodots'), false);
  assert.strictEqual(secrets.looksLikeJwt('a.b'), false);
  assert.strictEqual(secrets.looksLikeJwt('a.b.c.d'), false);
});

test('an empty or blank token is rejected', () => {
  assert.strictEqual(secrets.looksLikeJwt(''), false);
  assert.strictEqual(secrets.looksLikeJwt('   '), false);
  assert.strictEqual(secrets.looksLikeJwt(null), false);
});

test('a part that is empty is rejected', () => {
  assert.strictEqual(secrets.looksLikeJwt('a..c'), false);
});

test('a saved token round-trips through the crypto layer', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  secrets.save(JWT);
  assert.strictEqual(secrets.load(), JWT);
});

test('the token is not stored in plaintext on disk', () => {
  const d = tmp();
  store.setPath(d);
  secrets.setCrypto(fakeCrypto);
  secrets.save(JWT);
  const raw = fs.readFileSync(path.join(d, 'state.json'), 'utf8');
  assert.ok(!raw.includes(JWT), 'state.json must not contain the raw token');
});

test('saving a malformed token throws rather than storing garbage', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  assert.throws(() => secrets.save('not-a-jwt'), /JWT/);
});

test('loading with no token saved returns null', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  assert.strictEqual(secrets.load(), null);
});

test('clear removes the token', () => {
  store.setPath(tmp());
  secrets.setCrypto(fakeCrypto);
  secrets.save(JWT);
  secrets.clear();
  assert.strictEqual(secrets.load(), null);
});

test('an undecryptable blob loads as null rather than throwing', () => {
  store.setPath(tmp());
  secrets.setCrypto({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s),
    decryptString: () => { throw new Error('DPAPI failure'); },
  });
  secrets.save(JWT);
  assert.strictEqual(secrets.load(), null);
});
