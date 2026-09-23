'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('needs-user retry is wired through main, preload, auxiliary, and status popup surfaces', () => {
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  const preload = fs.readFileSync('src/preload.cjs', 'utf8');
  const auxiliary = fs.readFileSync('renderer/renderer.js', 'utf8');
  const popup = fs.readFileSync('renderer/popup.js', 'utf8');
  const html = fs.readFileSync('renderer/index.html', 'utf8');
  const popupHtml = fs.readFileSync('renderer/popup.html', 'utf8');
  assert.match(main, /handle\('retry-auth'.*automation\.retry\(\)/s);
  assert.match(preload, /retryAuth:\s*invoke\('retry-auth'\)/);
  assert.match(auxiliary, /retry-auth/);
  assert.match(popup, /retryAuth\(\)/);
  assert.match(html, /id="retry-auth"/);
  assert.match(popupHtml, /id="retry"/);
});
