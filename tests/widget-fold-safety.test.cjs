const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// The widget stayed expanded with the cursor long gone: a bubble minimized by "Show desktop"
// (Win+D) never sent 'hide', so the widget still counted it as open; Win+D also minimized the
// widget itself. These lock in the three guards.
test('a bubble minimized by Show desktop counts as closed', () => {
  const popover = fs.readFileSync('src/notch-popover.cjs', 'utf8');
  assert.match(popover, /created\.on\('minimize', \(\) => \{ if \(popup === created && !created\.isDestroyed\(\)\) created\.hide\(\); \}\);/);
});

test('the widget puts itself back, without taking focus, when something minimizes it', () => {
  const notch = fs.readFileSync('src/notch-window.cjs', 'utf8');
  assert.match(notch, /window\.on\('minimize', \(\) => \{\s*setTimeout\(\(\) => \{ if \(!window\.isDestroyed\(\) && window\.isMinimized\(\)\) window\.showInactive\(\); \}, 0\);/);
});

test('once a second, open-flags the screen contradicts are cleared', () => {
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  assert.match(main, /if \(held\.popupOpen && \(!bubble \|\| bubble\.isDestroyed\(\) \|\| !bubble\.isVisible\(\) \|\| bubble\.isMinimized\(\)\)\) notch\.dispatch\('popup', false\);/);
  assert.match(main, /if \(pointerAwayChecks >= 2\) \{ pointerAwayChecks = 0; notch\.dispatch\('pointer', false\); \}/);
  assert.match(main, /\}, 1000\);\s*foldWatch\.unref\?\.\(\);/);
});
