'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('Electron main wiring drives authentication transition and resumes through real IPC', () => {
  const output = execFileSync(process.execPath, ['scripts/qa-v2-ordinary-adapter.cjs'], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  const report = JSON.parse(output);
  assert.equal(report.pass, true);
  assert.equal(report.observable.realRendererIpc, true);
  assert.deepEqual(report.observable.phases, ['opening', 'awaiting-user-auth', 'authenticated', 'navigating', 'done']);
  assert.equal(report.observable.loginInvocations, 1);
  assert.equal(report.observable.originalActionInvocations, 1);
  assert.deepEqual(report.observable.draft.phases, ['opening', 'awaiting-user-auth', 'authenticated', 'navigating', 'done']);
  assert.equal(report.observable.draft.editorReused, false);
  assert.equal(report.observable.draft.publicFormInvocations, 1);
  assert.equal(report.observable.draftCarried.drafted, true);
  assert.equal(report.observable.draftCarried.wroteIntoExistingEditor, false);
  assert.equal(report.observable.browserProcessesLaunched, 0);
  assert.equal(report.cleanup.ownedProfileRemoved, true);
  assert.equal(report.cleanup.ordinaryEdgeUntouched, true);
});
