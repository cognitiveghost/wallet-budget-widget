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

// The window runs under style-src 'self', which refuses style attributes
// outright — silently, with the element simply unstyled. Geometry set through
// the CSSOM (el.style.left = …) is fine; a style attribute written into markup
// or via setAttribute is not.
test('the renderer never writes a style attribute', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.doesNotMatch(js, /setAttribute\(\s*['"]style['"]/);
  // svgEl() spreads its attrs through setAttribute, so a `style:` key holding
  // CSS is the same violation by another route. A declaration always carries a
  // colon of its own, which is what separates it from Intl's style: 'currency'.
  assert.doesNotMatch(js, /style:\s*['"`][^'"`]*:/);
  assert.doesNotMatch(html, /<[^>]+\sstyle=/);
});

test('the content policy allows the bundled font and nothing remote', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const csp = html.match(/Content-Security-Policy"[\s\S]*?content="([^"]+)"/);
  assert.ok(csp, 'no CSP meta tag');
  assert.match(csp[1], /font-src 'self'/);
  assert.match(csp[1], /default-src 'none'/);
  assert.doesNotMatch(csp[1], /https?:/);
});

// The preview harness is a second copy of the window's markup, and it drifted:
// #next was added to renderer/index.html and not here, so render() threw on a
// null element and every panel after it — budgets, due, inbox, sync — silently
// stopped drawing in the one tool the README points at for UI work.
test('the preview harness carries every element the renderer looks up', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const preview = fs.readFileSync(path.join(__dirname, 'preview.html'), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('([-\w]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 5, `only found ${ids.size} lookups — the scan broke`);
  for (const id of ids) {
    assert.match(preview, new RegExp(`id="${id}"`), `preview.html has no #${id}`);
  }
});

test('the median tick is positioned through the CSSOM, never a style attribute', () => {
  // The track's marks all scale through at(); the median must use the same one
  // or it lands on a different scale from the limit it is read against.
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(js.includes("el('div', 'median')"), 'renderBudgets must build a .median element');
  assert.ok(/median.*\.style\.left\s*=/s.test(js), 'the tick must be placed via style.left');
});

test('the stylesheet defines the median mark', () => {
  assert.ok(css.includes('.median'), 'style.css must carry a .median rule');
});

test('the split bar sizes its segments through the CSSOM', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(js.includes('function renderSplit'), 'app.js must define renderSplit');
  assert.ok(/renderSplit\(\$\('split'\)/.test(js), 'render() must call renderSplit');
  assert.ok(/\.style\.width\s*=/.test(js), 'segment widths must be set as properties');
});

test('the split bar has a home in the markup and the stylesheet', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('id="split"'), 'index.html must carry #split');
  assert.ok(html.includes('id="insight"'), 'index.html must carry #insight');
  assert.ok(css.includes('.sbar'), 'style.css must carry the bar rules');
});
