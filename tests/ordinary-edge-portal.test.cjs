'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PortalAutomation } = require('../src/portal.cjs');
const { OrdinaryEdgeAdapter } = require('../src/ordinary-edge.cjs');

function expiryHarness(stage) {
  const target = { pid: 4312, hwnd: '9988', processStartedAt: '2026-09-20T10:00:00Z' };
  const certificate = { visible: false, hardDiskAvailable: false, removableAvailable: false, selectedStore: null, hardDiskEmpty: null, driveOptions: [], driveOptionsToken: null, selectedDriveId: null, certRowCount: null, selectedCertRowCount: null, soleCertRowSelectable: false };
  const login = { ...target, origin: 'https://sen.eduptl.kr', authenticated: false, loginAvailable: true, landing: null, availableSystems: ['portal'], actions: [], certificate };
  const ready = { ...login, authenticated: true, loginAvailable: false, landing: 'portal', availableSystems: ['portal', 'neis'] };
  const task = { ...ready, authenticated: false, landing: 'neis', origin: 'https://sen.neis.go.kr', neisTaskState: { myMenuSelected: true, dutyExpanded: true, visibleTasks: ['attendance'], existingTaskTabs: [], activeTask: null, actions: ['open-attendance'] } };
  let snapshots = [];
  let time = 0;
  const calls = [];
  const phases = [];
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => {
      calls.push(request);
      if (request.command === 'invoke') return { status: 'ok', windows: [], invoked: true };
      const snapshot = snapshots.shift();
      return typeof snapshot === 'function' ? snapshot() : { status: 'ok', windows: [snapshot] };
    },
    openExternal: async () => { throw new Error('Unexpected external open'); },
    now: () => time, pause: async milliseconds => { time += milliseconds; }, landingTimeoutMs: 500,
  });
  const automation = new PortalAutomation({ status: event => phases.push(event.phase), openPortal: adapter.openOfficialPortal.bind(adapter), observeAuthenticated: adapter.observeAuthenticated.bind(adapter), resumeAction: adapter.resumeAction.bind(adapter), pause: async () => {} });
  return {
    automation, calls, phases,
    completedSnapshot: { status: 'ok', windows: [{ ...task, neisTaskState: { ...task.neisTaskState, activeTask: 'attendance' } }] },
    expire() { snapshots = stage === 'resume' ? [ready, login] : stage === 'poll' ? [ready, ready, login] : [ready, ready, task, login]; },
    succeed(last = null) { snapshots = [ready, ready, last || { ...task, neisTaskState: { ...task.neisTaskState, activeTask: 'attendance' } }]; },
  };
}

for (const stage of ['resume', 'poll', 'task']) {
  test(`verified login return during ${stage} preserves explicit retry and completes once after fresh authentication`, async () => {
    const harness = expiryHarness(stage);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      harness.expire();
      const result = attempt === 0 ? await harness.automation.openMenu('attendance') : await harness.automation.retry();
      assert.equal(result.phase, 'needs-user');
      assert.equal(harness.automation.retryAction, 'attendance');
      assert.equal(harness.phases.includes('done'), false);
      assert.equal(harness.automation.busy, false);
    }
    harness.succeed();
    assert.equal((await harness.automation.retry()).phase, 'done');
    assert.equal(harness.phases.filter(phase => phase === 'done').length, 1);
    assert.equal(harness.automation.retryAction, null);
    assert.equal((await harness.automation.retry()).ok, false);
    assert.equal(harness.calls.filter(call => call.action === 'activate-system-tab').length, stage === 'resume' ? 1 : 3);
  });
}

test('cancelled authentication retry ignores late verified landing', async () => {
  const harness = expiryHarness('resume');
  harness.expire();
  assert.equal((await harness.automation.openMenu('attendance')).phase, 'needs-user');
  const late = deferred();
  harness.succeed(() => late.promise);
  const pending = harness.automation.retry();
  await new Promise(resolve => setImmediate(resolve));
  harness.automation.cancel();
  assert.equal((await pending).phase, 'cancelled');
  harness.succeed();
  assert.equal((await harness.automation.openMenu('attendance')).phase, 'done');
  late.resolve(harness.completedSnapshot);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.phases.filter(phase => phase === 'done').length, 1);
  assert.equal(harness.automation.retryAction, null);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('ordinary Edge callbacks share the owned operation and resume the original action once', async () => {
  const calls = [];
  let checks = 0;
  let openedOperation;
  let observedOperation;
  let resumedOperation;
  const automation = new PortalAutomation({
    status: event => calls.push(event.phase),
    openPortal: async (url, operation) => { calls.push(url); openedOperation = operation; },
    observeAuthenticated: async operation => { observedOperation = operation; checks += 1; return checks >= 2; },
    resumeAction: async (action, operation) => { calls.push(`resume:${action}`); resumedOperation = operation; return { verified: false }; },
    pause: async () => {},
    authTimeoutMs: 1000,
  });
  const result = await automation.openMenu('neis');
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'opened');
  assert.ok(openedOperation && typeof openedOperation === 'object');
  assert.equal(openedOperation, observedOperation);
  assert.equal(observedOperation, resumedOperation);
  assert.equal(calls.filter(value => value === 'resume:neis').length, 1);
  assert.deepEqual(calls.filter(value => ['opening', 'awaiting-user-auth', 'authenticated', 'navigating', 'opened', 'done'].includes(value)), ['opening', 'awaiting-user-auth', 'authenticated', 'navigating', 'opened']);
});

test('verified portal reuse completes from the existing authenticated surface', async () => {
  const phases = [];
  const automation = new PortalAutomation({
    status: event => phases.push(event.phase),
    openPortal: async () => {},
    observeAuthenticated: async () => true,
    resumeAction: async action => ({ verified: action === 'portal' }),
    pause: async () => {},
  });
  const result = await automation.openMenu('portal');
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'done');
  assert.equal(phases.at(-1), 'done');
});

test('cancel during native observation prevents a late authenticated result from resuming', async () => {
  const observation = deferred();
  let resumes = 0;
  const automation = new PortalAutomation({
    status: () => {},
    openPortal: async () => {},
    observeAuthenticated: () => observation.promise,
    resumeAction: async () => { resumes += 1; },
    pause: async () => {},
    authTimeoutMs: 1000,
  });
  const pending = automation.openMenu('neis');
  await new Promise(resolve => setImmediate(resolve));
  automation.cancel();
  observation.resolve(true);
  assert.equal((await pending).phase, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumes, 0);
});

test('operation cancellation notifies owned helper subscribers once', () => {
  const automation = new PortalAutomation({ status: () => {} });
  const operation = automation.createOperation('draft');
  automation.operation = operation;
  let notifications = 0;
  const unsubscribe = operation.onCancel(() => { notifications += 1; });
  automation.cancel();
  unsubscribe();
  operation.cancel();
  assert.equal(notifications, 1);
});

test('draft handoff needs-user remains retryable and never reports done', async () => {
  const phases = [];
  const error = Object.assign(new Error('Public form selector is unavailable'), { code: 'needs-user' });
  const automation = new PortalAutomation({
    status: event => phases.push(event.phase), openPortal: async () => {}, observeAuthenticated: async () => true,
    resumeAction: async () => { throw error; }, pause: async () => {},
  });
  const result = await automation.openMenu('draft');
  assert.equal(result.phase, 'needs-user');
  assert.equal(automation.diagnostics().retryAvailable, true);
  assert.equal(phases.includes('done'), false);
});

test('draft double click starts one handoff operation', async () => {
  let release;
  let resumes = 0;
  const pendingResume = new Promise(resolve => { release = resolve; });
  const automation = new PortalAutomation({
    status: () => {}, openPortal: async () => {}, observeAuthenticated: async () => true,
    resumeAction: async () => { resumes += 1; return pendingResume; }, pause: async () => {},
  });
  const first = automation.openMenu('draft');
  await new Promise(resolve => setImmediate(resolve));
  const second = await automation.openMenu('draft');
  assert.equal(second.ok, false);
  assert.equal(resumes, 1);
  release({ verified: true });
  assert.equal((await first).phase, 'done');
});
