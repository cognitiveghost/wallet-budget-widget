const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');

// #gate and #dash are toggled with the `hidden` attribute, and an id selector
// that sets `display` outranks the UA stylesheet's [hidden] rule. Without this
// override the gate stays painted over a fully-loaded dashboard: "I press
// Connect and nothing happens".
test('the hidden attribute outranks the id rules that set display', () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});
