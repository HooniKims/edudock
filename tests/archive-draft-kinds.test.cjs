'use strict';

// The archived 출장·근무상황 draft generator stays working so it can be reused later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { generateNeisDraft } = require('../archive/draft-kinds.cjs');

test('archived trip and attendance drafts include only supplied information', () => {
  assert.equal(generateNeisDraft({ kind: 'trip', title: '연수', purpose: '직무연수', place: '교육청' }).body, '출장 목적: 직무연수\n출장지: 교육청');
  assert.equal(generateNeisDraft({ kind: 'attendance', title: '연가', purpose: '개인 사유', leaveType: '연가' }).body, '근무상황 종류: 연가\n사유: 개인 사유');
  assert.equal(generateNeisDraft({ kind: 'trip', title: '연수', purpose: '연수', date: '2026-10-15', startTime: '14:00', endTime: '17:00' }).body, '출장 목적: 연수\n출장 일시: 2026. 10. 15.(목) 14:00~17:00');
  assert.throws(() => generateNeisDraft({ kind: 'trip', title: '출장', purpose: '연수', startTime: '15:00', endTime: '14:00' }));
});

test('the archive is not shipped in the app', () => {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(!manifest.build.files.some(pattern => /archive/.test(pattern)));
  assert.ok(manifest.build.files.every(pattern => pattern.startsWith('!') || /^(src|renderer|assets)\/|^package\.json$/.test(pattern)));
});
