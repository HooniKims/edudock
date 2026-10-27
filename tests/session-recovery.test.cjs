'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrdinaryEdgeAdapter } = require('../src/ordinary-edge.cjs');
const { PortalAutomation } = require('../src/portal.cjs');

function harness({ stuck = false, expiresAgain = false, autoLogin = true, hasPortal = true, passwordFailure = false } = {}) {
  const target = { pid: 1234, hwnd: '12345', processStartedAt: '2026-10-11T00:00:00Z' };
  const cert = { visible: false, hardDiskAvailable: false, removableAvailable: false, selectedStore: null, hardDiskEmpty: null, driveOptions: [], driveOptionsToken: null, selectedDriveId: null, certRowCount: null, selectedCertRowCount: null, soleCertRowSelectable: false };
  const base = { ...target, origin: 'https://klef.sen.go.kr', authenticated: false, loginAvailable: false, landing: null, selectedSystem: 'edufine', availableSystems: hasPortal ? ['portal', 'edufine'] : ['edufine'], actions: [], certificate: cert };
  let phase = 'expired';
  let time = 0;
  let cleared = 0;
  const calls = [], external = [], statuses = [];
  const snapshot = () => {
    if (phase === 'expired') return { ...base, sessionNotice: 'edufine-usetime', landing: 'edufine', authenticated: true };
    if (phase === 'stale') return base;
    if (phase === 'ready') return { ...base, landing: 'edufine' };
    const portal = { ...base, origin: 'https://sen.eduptl.kr', selectedSystem: 'portal' };
    if (phase === 'login') return { ...portal, loginAvailable: true, actions: ['login'] };
    if (phase === 'certificate') return { ...portal, certificate: { ...cert, visible: true, selectedStore: 'hard-disk', certRowCount: 1, selectedCertRowCount: 1 } };
    return { ...portal, authenticated: true, landing: 'portal', actions: ['portal', 'edufine'] };
  };
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => {
      // Test-only secret: never use the real profile or password in this harness.
      calls.push(request);
      if (request.action === 'dismiss-session-notice' && !stuck) phase = 'stale';
      if (request.action === 'activate-system-tab' && request.system === 'portal') phase = 'login';
      if (request.action === 'login') phase = 'certificate';
      if (request.action === 'submit-certificate-password') {
        if (passwordFailure) return { status: 'unavailable', windows: [snapshot()], invoked: false };
        phase = 'authenticated';
      }
      if (request.action === 'edufine') phase = expiresAgain ? 'login' : 'ready';
      return { status: 'ok', windows: [snapshot()], ...(request.command === 'invoke' ? { invoked: true } : {}) };
    },
    openExternal: async url => { external.push(url); phase = 'login'; },
    getStoredPassword: () => 'test-only-password', onPasswordRejected: () => { cleared += 1; },
    now: () => time, pause: async ms => { time += ms; }, landingTimeoutMs: 1200,
  });
  const automation = new PortalAutomation({
    autoLogin, status: value => statuses.push(value),
    openPortal: adapter.openOfficialPortal.bind(adapter), observeAuthenticated: adapter.observeAuthenticated.bind(adapter), resumeAction: adapter.resumeAction.bind(adapter), pause: async () => {},
  });
  return { automation, calls, external, statuses, cleared: () => cleared };
}

test('expired business tab recovers via existing portal, logs in once, and completes the requested screen', async () => {
  const h = harness();
  assert.equal((await h.automation.openMenu('edufine')).phase, 'done');
  assert.deepEqual(h.calls.filter(c => c.command === 'invoke').map(c => c.action), [
    'dismiss-session-notice', 'activate-system-tab', 'login', 'submit-certificate-password', 'edufine', 'activate-system-tab',
  ]);
  assert.equal(h.external.length, 0);
  assert.equal(h.cleared(), 0);
  assert.equal(h.automation.autoLogin, true);
  assert.equal(h.statuses.filter(s => s.phase === 'done').length, 1);
});

test('recovery opens only the official portal when no portal tab exists', async () => {
  const h = harness({ hasPortal: false });
  assert.equal((await h.automation.openMenu('edufine')).phase, 'done');
  assert.deepEqual(h.external, ['https://sen.eduptl.kr']);
});

test('a persistent expiry overlay cannot pass as login despite stale authenticated markers underneath', async () => {
  const h = harness({ stuck: true });
  const result = await h.automation.openMenu('edufine');
  assert.equal(result.phase, 'needs-user');
  assert.match(result.message, /안내가 닫히지/);
  assert.deepEqual(h.calls.filter(c => c.command === 'invoke').map(c => c.action), ['dismiss-session-notice']);
  assert.equal(h.statuses.some(s => s.phase === 'done'), false);
});

test('expiry after recovery stops without looping or replaying the password', async () => {
  const h = harness({ expiresAgain: true });
  assert.equal((await h.automation.openMenu('edufine')).phase, 'needs-user');
  assert.equal(h.calls.filter(c => c.action === 'submit-certificate-password').length, 1);
  assert.equal(h.calls.filter(c => c.action === 'edufine').length, 1);
  assert.equal(h.automation.retryAction, 'edufine');
});

test('an automatic-input failure preserves the secret and automatic-login setting', async () => {
  const h = harness({ passwordFailure: true });
  assert.equal((await h.automation.openMenu('edufine')).phase, 'needs-user');
  assert.equal(h.cleared(), 0);
  assert.equal(h.automation.autoLogin, true);
  assert.equal(h.calls.filter(c => c.action === 'submit-certificate-password').length, 1);
});

test('disabled automatic login retains the existing explicit retry flow', async () => {
  const h = harness({ autoLogin: false });
  assert.equal((await h.automation.openMenu('edufine')).phase, 'needs-user');
  assert.equal(h.calls.some(c => c.action === 'submit-certificate-password'), false);
});

test('cancel during recovery prevents late login and original action resumption', async () => {
  let unblock;
  let resumes = 0;
  const recovery = new Promise(resolve => { unblock = resolve; });
  const automation = new PortalAutomation({
    autoLogin: true, status: () => {}, pause: async () => {},
    openPortal: async (_url, _operation, options) => { if (options?.recoverSession) await recovery; },
    observeAuthenticated: async () => true,
    resumeAction: async () => { resumes += 1; throw Object.assign(new Error('expired'), { code: 'needs-user', reason: 'authentication-required' }); },
  });
  const pending = automation.openMenu('trip');
  await new Promise(resolve => setImmediate(resolve));
  automation.cancel();
  unblock();
  assert.equal((await pending).phase, 'cancelled');
  assert.equal(resumes, 1);
});

test('draft content and operation identity survive recovery, while editor errors never trigger it', async () => {
  const draft = { title: 'test draft' };
  const operations = [];
  let resumes = 0, recoveries = 0;
  const automation = new PortalAutomation({
    autoLogin: true, status: () => {}, pause: async () => {},
    openPortal: async (_url, op, options) => { operations.push(op); if (options?.recoverSession) recoveries += 1; },
    observeAuthenticated: async () => true,
    resumeAction: async (_action, op, options) => {
      operations.push(op);
      assert.equal(options.draft, draft);
      if (++resumes === 1) throw Object.assign(new Error('expired'), { code: 'needs-user', reason: 'authentication-required' });
      throw Object.assign(new Error('editor has content'), { code: 'needs-user', reason: 'not-blank' });
    },
  });
  assert.equal((await automation.openMenu('draft', { draft })).phase, 'needs-user');
  assert.equal(recoveries, 1);
  assert.equal(resumes, 2);
  assert.ok(operations.every(op => op === operations[0]));
});
