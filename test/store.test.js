const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../main/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wbw-'));

test('a missing state file loads as defaults rather than throwing', () => {
  store.setPath(tmp());
  assert.deepStrictEqual(store.load(), { window: null, token: null, notified: {} });
});

test('a saved state round-trips', () => {
  store.setPath(tmp());
  store.save({ window: { x: 1, y: 2, w: 3, h: 4 }, token: 'blob', notified: { a: 1 } });
  assert.deepStrictEqual(store.load().window, { x: 1, y: 2, w: 3, h: 4 });
  assert.strictEqual(store.load().token, 'blob');
});

test('a corrupt state file loads as defaults rather than throwing', () => {
  const d = tmp();
  store.setPath(d);
  fs.writeFileSync(path.join(d, 'state.json'), '{not json');
  assert.deepStrictEqual(store.load(), { window: null, token: null, notified: {} });
});

test('a partial state file is filled in with defaults', () => {
  const d = tmp();
  store.setPath(d);
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ token: 'x' }));
  const s = store.load();
  assert.strictEqual(s.token, 'x');
  assert.deepStrictEqual(s.notified, {});
});
