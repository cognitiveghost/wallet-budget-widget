const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../main/snapshot');

const file = path.join(__dirname, 'fixtures', 'live.json');

test('a real captured snapshot produces finite, signed-correct projections', { skip: !fs.existsSync(file) }, () => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = build({ ...raw, uncategorized: [] }, '2026-09-18');

  assert.ok(s.budgets.length > 0, 'fixture should carry budgets');
  for (const b of s.budgets) {
    assert.ok(Number.isFinite(b.projected), `${b.name} projected must be finite`);
    assert.ok(b.projected >= 0, `${b.name} projected must not be negative`);
    assert.ok(b.projected >= b.spent - 0.01, `${b.name} must project at least what is spent`);
    assert.ok(b.discretionary >= 0, `${b.name} discretionary must not be negative`);
  }
  assert.ok(Number.isFinite(s.runway.end), 'runway end must be finite');
  assert.ok(s.runway.actual.length > 0, 'runway must have an actual leg');
});
