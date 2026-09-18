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
