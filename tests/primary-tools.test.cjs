'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sanitizedSettings } = require('../src/settings.cjs');

const PRIMARY_BUTTONS = ['neis', 'edufine', 'attendance', 'trip', 'draft', 'compose'];

test('fresh settings prioritize NEIS and K-EduFine', () => {
  assert.deepEqual(sanitizedSettings({}).buttons, PRIMARY_BUTTONS);
});

test('legacy portal button migrates in place without losing other settings', () => {
  const settings = sanitizedSettings({
    schemaVersion: 4,
    autoLogin: true,
    certificateDriveHint: 'D:',
    alwaysOnTop: false,
    displayMode: 'auto',
    placement: { edge: 'bottom', monitorId: 'display-2', offsets: { bottom: 0.3 }, scale: 1.25 },
    buttons: ['portal', 'neis', 'attendance', 'trip', 'draft', 'compose'],
  });
  assert.deepEqual(settings.buttons, ['edufine', 'neis', 'attendance', 'trip', 'draft', 'compose']);
  assert.equal(settings.autoLogin, true);
  assert.equal(settings.certificateDriveHint, 'D:');
  assert.equal(settings.placement.edge, 'bottom');
  assert.equal(settings.placement.monitorId, 'display-2');
  assert.equal(settings.placement.offsets.bottom, 0.3);
  assert.equal(settings.placement.scale, 1.25);
});

test('button migration preserves valid custom order and repairs stale, missing, and duplicate entries', () => {
  const settings = sanitizedSettings({
    schemaVersion: 4,
    buttons: ['trip', 'portal', 'trip', 'unknown', 'compose', 'neis'],
  });
  assert.deepEqual(settings.buttons, ['trip', 'edufine', 'compose', 'neis', 'attendance', 'draft']);
});

test('notch presents one NEIS and one K-EduFine primary menu, with no portal primary menu', () => {
  const markup = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'notch.html'), 'utf8');
  const menuCount = id => (markup.match(new RegExp(`data-menu="${id}"`, 'g')) || []).length;
  assert.equal(menuCount('neis'), 1);
  assert.equal(menuCount('edufine'), 1);
  assert.equal(menuCount('portal'), 0);
  assert.match(markup, /data-menu="neis"[^>]*aria-label="나이스"/);
  assert.match(markup, /data-menu="edufine"[^>]*aria-label="K-에듀파인"/);
});
