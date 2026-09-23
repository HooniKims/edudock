'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PortalAutomation } = require('../src/portal.cjs');
const { AuthenticationTimeoutError } = require('../src/auth.cjs');

function fixture(events) {
  const page = {
    url: () => 'https://sen.eduptl.kr/',
    bringToFront: async () => {},
  };
  const context = { pages: () => [page] };
  const automation = new PortalAutomation({ profile: 'fixture', status: event => events.push(event) });
  automation.browser = async () => context;
  automation.readyPortal = async () => {};
  return automation;
}

test('no-input authentication timeout becomes needs-user and releases pending work for retry', async () => {
  const events = [];
  const automation = fixture(events);
  automation.login = async () => { throw new AuthenticationTimeoutError(); };

  const timedOut = await automation.openMenu('portal');
  assert.deepEqual(timedOut, {
    ok: false,
    phase: 'needs-user',
    message: '인증 대기 시간이 끝났습니다. Edge에서 인증을 다시 시작해 주세요.',
  });
  assert.deepEqual(events.at(-1), {
    phase: 'needs-user',
    message: timedOut.message,
    busy: false,
  });
  assert.equal(automation.busy, false);
  assert.equal(automation.operation, null);

  automation.login = async () => true;
  const retried = await automation.openMenu('portal');
  assert.equal(retried.ok, true);
  assert.equal(automation.busy, false);
  assert.equal(automation.operation, null);
});

test('ordinary portal failures remain errors after timeout classification is added', async () => {
  const events = [];
  const automation = fixture(events);
  automation.login = async () => { throw new Error('fixture connection failed'); };

  const result = await automation.openMenu('portal');
  assert.deepEqual(result, { ok: false, message: 'fixture connection failed' });
  assert.equal(events.at(-1).phase, 'error');
});
