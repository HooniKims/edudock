'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { NativeOrdinaryEdgeBridge, OrdinaryEdgeAdapter, resolveOrdinaryEdgeHelper, resolveDraftHandoffHelper, validateResponse } = require('../src/ordinary-edge.cjs');
const { DraftHandoffCoordinator, EXPECTED_FORM_CAPTION, REQUIRED_MARKERS } = require('../src/draft-handoff.cjs');

const target = { pid: 4312, hwnd: '9988', processStartedAt: '2026-09-20T10:00:00.0000000Z' };
const certificate = (patch = {}) => ({
  visible: false,
  hardDiskAvailable: false,
  removableAvailable: false,
  selectedStore: null,
  hardDiskEmpty: null,
  driveOptions: [],
  driveOptionsToken: null,
  selectedDriveId: null,
  certRowCount: null,
  selectedCertRowCount: null,
  soleCertRowSelectable: false,
  ...patch,
});
const windowState = (patch = {}) => ({ ...target, origin: 'https://sen.eduptl.kr', authenticated: false, loginAvailable: false, certificate: certificate(), actions: [], landing: patch.authenticated === true ? 'portal' : null, availableSystems: ['portal'], ...patch });
const reply = (windows, patch = {}) => ({ status: 'ok', windows, ...patch });
const neisTaskState = (patch = {}) => ({ myMenuSelected: false, dutyExpanded: false, visibleTasks: [], existingTaskTabs: [], activeTask: null, actions: [], ...patch });
const operation = () => {
  let cancel;
  const cancellation = new Promise(resolve => { cancel = resolve; });
  return { cancelled: false, cancellation, cancel };
};

test('only a fresh exact-target portal login return requests authentication retry', async () => {
  const login = windowState({ loginAvailable: true });
  const cases = [
    [reply([login]), true],
    [reply([login], { status: 'stale' }), false],
    [reply([login], { status: 'ambiguous' }), false],
    [reply([]), false],
    [reply([login, login]), false],
    [reply([{ ...login, processStartedAt: '2026-09-21T00:00:00Z' }]), false],
    [reply([{ ...login, origin: null }]), false],
    [reply([{ ...login, origin: 'https://sen.neis.go.kr' }]), false],
    [reply([{ ...login, loginAvailable: false }]), false],
    [reply([{ ...login, loginAvailable: 'true' }]), false],
  ];
  for (const [snapshot, retryable] of cases) {
    const adapter = new OrdinaryEdgeAdapter({ runNative: async () => snapshot, openExternal: async () => {} });
    const op = operation();
    adapter.state(op).target = target;
    await assert.rejects(adapter.resumeAction('attendance', op), error => {
      assert.equal(error.reason === 'authentication-required', retryable);
      return true;
    });
    if (retryable) await assert.rejects(adapter.resumeAction('attendance', op), /already resumed/);
  }
});

test('packaged helper resolves through app.asar.unpacked and development uses source', () => {
  assert.equal(resolveOrdinaryEdgeHelper({ isPackaged: true, resourcesPath: 'C:\\Program Files\\EduDock\\resources' }), path.join('C:\\Program Files\\EduDock\\resources', 'app.asar.unpacked', 'src', 'native', 'ordinary-edge.ps1'));
  assert.equal(resolveOrdinaryEdgeHelper({ isPackaged: false, sourceDirectory: 'D:\\repo\\src' }), path.join('D:\\repo\\src', 'native', 'ordinary-edge.ps1'));
  assert.equal(resolveDraftHandoffHelper({ isPackaged: true, resourcesPath: 'C:\\Program Files\\EduDock\\resources' }), path.join('C:\\Program Files\\EduDock\\resources', 'app.asar.unpacked', 'src', 'native', 'edufine-draft.ps1'));
});

test('native bridge uses hidden shell-free PowerShell with one compact JSON request', async () => {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end(value) { calls.push({ file, args, options, value }); setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(reply([])))); child.emit('close', 0); }); } };
    child.kill = () => true;
    return child;
  };
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'C:\\app\\ordinary-edge.ps1', spawn, timeoutMs: 1000 });
  assert.deepEqual(await bridge.run({ command: 'inspect' }, operation()), reply([]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.deepEqual(calls[0].args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\app\\ordinary-edge.ps1']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].value, '{"command":"inspect"}');
});

test('native bridge rejects malformed and misleading success output', async () => {
  for (const output of ['not json', '{"status":"ok","windows":[]}{"status":"ok","windows":[]}', '{"status":"ok","windows":[{"pid":1}]}']) {
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { end() { setImmediate(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0); }); } };
      child.kill = () => true;
      return child;
    };
    const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'fixture.ps1', spawn, timeoutMs: 1000 });
    await assert.rejects(bridge.run({ command: 'inspect' }, operation()), error => error.reason === 'invalid-response');
  }
});

test('native bridge reports a synchronous helper bootstrap failure', async () => {
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'fixture.ps1', spawn: () => { throw new Error('bootstrap failed'); }, timeoutMs: 1000 });
  await assert.rejects(bridge.run({ command: 'inspect' }, operation()), /bootstrap failed/);
});

test('native bridge contains an early stdin broken-pipe error', async () => {
  let killed = 0;
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => child.stdin.emit('error', new Error('EPIPE')));
    child.kill = () => { killed += 1; return true; };
    return child;
  };
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'fixture.ps1', spawn, timeoutMs: 1000 });
  await assert.rejects(bridge.run({ command: 'inspect' }, operation()), /EPIPE/);
  assert.equal(killed, 1);
});

test('cancellation kills only the owned helper and ignores late output', async () => {
  let killed = 0;
  let child;
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end() {} }; child.kill = () => { killed += 1; return true; };
    return child;
  };
  const op = operation();
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'fixture.ps1', spawn, timeoutMs: 1000 });
  const pending = bridge.run({ command: 'inspect' }, op);
  op.cancelled = true; op.cancel();
  await assert.rejects(pending, /cancel/i);
  child.stdout.emit('data', Buffer.from(JSON.stringify(reply([windowState({ authenticated: true })]))));
  child.emit('close', 0);
  assert.equal(killed, 1);
});

test('native helper deadline kills the owned long-running process', async () => {
  let killed = 0;
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end() {} }; child.kill = () => { killed += 1; return true; };
    return child;
  };
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'fixture.ps1', spawn, timeoutMs: 10 });
  await assert.rejects(bridge.run({ command: 'inspect' }, operation()), error => error.reason === 'helper-timeout');
  assert.equal(killed, 1);
});

test('adapter inspects before opening and accepts only one exact trusted authenticated window', async () => {
  const opened = [];
  const requests = [];
  const responses = [reply([windowState({ authenticated: true, actions: ['portal'] })])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async url => opened.push(url) });
  const op = operation();
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.deepEqual(requests, [{ command: 'inspect', restoreMinimised: true }]);
  assert.deepEqual(opened, []);
  assert.equal(await adapter.observeAuthenticated(op), true);
});

test('wrong origin, stale response, and duplicate windows never authenticate or invoke', async () => {
  const wrongOriginRequests = [];
  const wrongOriginAdapter = new OrdinaryEdgeAdapter({ runNative: async request => { wrongOriginRequests.push(request); return reply([windowState({ origin: 'https://sen.eduptl.kr.evil.example', authenticated: true, loginAvailable: true })]); }, openExternal: async () => {} });
  await assert.rejects(wrongOriginAdapter.observeAuthenticated(operation()), error => error.reason === 'invalid-response');
  assert.equal(wrongOriginRequests.some(request => request.command === 'invoke'), false);
  for (const response of [
    { status: 'stale', windows: [windowState({ authenticated: true })] },
    reply([windowState({ authenticated: true }), windowState({ hwnd: '9989', authenticated: true })]),
  ]) {
    const requests = [];
    const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return response; }, openExternal: async () => {} });
    if (response.windows.length > 1) await assert.rejects(adapter.observeAuthenticated(operation()), error => error.reason === 'ambiguous-window');
    else assert.equal(await adapter.observeAuthenticated(operation()), false);
    assert.equal(requests.some(request => request.command === 'invoke'), false);
  }
});

test('an explicit user-selected removable store is preserved', async () => {
  const requests = [];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return reply([windowState({ certificate: certificate({ visible: true, hardDiskAvailable: true, removableAvailable: true, selectedStore: 'removable-disk', hardDiskEmpty: false }) })]); }, openExternal: async () => {} });
  assert.equal(await adapter.observeAuthenticated(operation()), false);
  assert.deepEqual(requests, [{ command: 'inspect' }]);
});

test('operation invokes verified login, hard disk, then removable only after explicit empty signal', async () => {
  const requests = [];
  const responses = [
    reply([windowState({ loginAvailable: true })]), reply([windowState()], { invoked: true }),
    reply([windowState({ certificate: certificate({ visible: true, hardDiskAvailable: true }) })]), reply([windowState()], { invoked: true }),
    reply([windowState({ certificate: certificate({ visible: true, removableAvailable: true, selectedStore: 'hard-disk', hardDiskEmpty: true, certRowCount: 0, selectedCertRowCount: 0 }) })]), reply([windowState()], { invoked: true }),
    reply([windowState({ authenticated: true, actions: ['neis'] })]),
  ];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['login', 'hard-disk', 'removable-disk']);
});

test('last successful removable drive hint is tried first only when present in fresh options', async () => {
  const requests = [];
  const removable = certificate({
    visible: true,
    removableAvailable: true,
    selectedStore: 'removable-disk',
    driveOptions: [{ id: 'D:', label: 'DATA(D:)', selected: true }, { id: 'E:', label: 'USB(E:)', selected: false }],
    driveOptionsToken: 'options-1',
    selectedDriveId: 'D:',
    certRowCount: 0,
    selectedCertRowCount: 0,
  });
  const responses = [reply([windowState({ certificate: removable })]), reply([windowState()], { invoked: true })];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, getDriveHint: () => 'E:' });
  assert.equal(await adapter.observeAuthenticated(operation()), false);
  assert.deepEqual(requests.at(-1), { command: 'invoke', target, action: 'select-drive', driveId: 'E:', driveOptionsToken: 'options-1' });
});

test('unavailable hint falls back through drives until the next drive has one certificate row', async () => {
  const requests = [];
  const options = [{ id: 'D:', label: 'DATA(D:)', selected: true }, { id: 'E:', label: 'USB(E:)', selected: false }];
  const responses = [
    reply([windowState({ certificate: certificate({ visible: true, removableAvailable: true, selectedStore: 'removable-disk', driveOptions: options, driveOptionsToken: 'options-1', selectedDriveId: 'D:', certRowCount: 0, selectedCertRowCount: 0 }) })]),
    reply([windowState()], { invoked: true }),
    reply([windowState({ certificate: certificate({ visible: true, removableAvailable: true, selectedStore: 'removable-disk', driveOptions: options.map(option => ({ ...option, selected: option.id === 'E:' })), driveOptionsToken: 'options-2', selectedDriveId: 'E:', certRowCount: 1, selectedCertRowCount: 0, soleCertRowSelectable: true }) })]),
    reply([windowState()], { invoked: true }),
  ];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, getDriveHint: () => 'Z:' });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['select-drive', 'select-certificate-row']);
  assert.equal(requests[1].driveId, 'E:');
  assert.equal(Object.hasOwn(requests[3], 'certificateName'), false);
  assert.equal(Object.hasOwn(requests[3], 'rowIndex'), false);
});

test('no removable drives or multiple certificate rows waits for user without fake progress', async () => {
  for (const certificateState of [
    certificate({ visible: true, removableAvailable: true, selectedStore: 'removable-disk', driveOptions: [], driveOptionsToken: 'empty', certRowCount: 0, selectedCertRowCount: 0 }),
    certificate({ visible: true, removableAvailable: true, selectedStore: 'removable-disk', driveOptions: [{ id: 'D:', label: 'DATA(D:)', selected: true }], driveOptionsToken: 'multi', selectedDriveId: 'D:', certRowCount: 2, selectedCertRowCount: 0 }),
  ]) {
    const requests = [];
    const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return reply([windowState({ certificate: certificateState })]); }, openExternal: async () => {}, getDriveHint: () => null });
    assert.equal(await adapter.observeAuthenticated(operation()), false);
    assert.equal(requests.some(request => request.command === 'invoke'), false);
  }
});

test('user-selected drive is preserved and saved only after trusted authentication', async () => {
  const saved = [];
  const requests = [];
  const responses = [
    reply([windowState({ certificate: certificate({ visible: true, removableAvailable: true, selectedStore: 'removable-disk', driveOptions: [{ id: 'D:', label: 'DATA(D:)', selected: true }], driveOptionsToken: 'user', selectedDriveId: 'D:', certRowCount: 1, selectedCertRowCount: 1, soleCertRowSelectable: true }) })]),
    reply([windowState({ authenticated: true, actions: ['portal'] })]),
  ];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, getDriveHint: () => null, saveDriveHint: id => saved.push(id) });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.deepEqual(saved, []);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(saved, ['D:']);
  assert.equal(requests.some(request => request.command === 'invoke'), false);
});

test('unknown hard-disk state never falls back to removable media', async () => {
  const requests = [];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return reply([windowState({ certificate: certificate({ visible: true, removableAvailable: true, hardDiskEmpty: null }) })]); }, openExternal: async () => {} });
  assert.equal(await adapter.observeAuthenticated(operation()), false);
  assert.deepEqual(requests, [{ command: 'inspect' }]);
});

test('resume revalidates identity and authentication and consumes one allowed action exactly once', async () => {
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['neis'], availableSystems: ['portal', 'neis'] });
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['portal', 'neis'] });
  const responses = [reply([portal]), reply([portal]), reply([neis], { invoked: true }), reply([neis])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  await adapter.resumeAction('neis', op);
  await assert.rejects(adapter.resumeAction('neis', op), /already resumed/i);
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['activate-system-tab']);
});

test('misleading invoke success without invoked true is rejected and cannot be replayed', async () => {
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['neis'], availableSystems: ['portal', 'neis'] });
  const responses = [reply([portal]), reply([portal]), reply([portal], { invoked: false })];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('neis', op), error => error.reason === 'not-invoked');
  await assert.rejects(adapter.resumeAction('neis', op), /already resumed/i);
  assert.equal(requests.filter(request => request.command === 'invoke').length, 1);
});

test('unsupported or unavailable action fails honestly without an invoke', async () => {
  const requests = [];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return reply([windowState({ authenticated: true, actions: [] })]); }, openExternal: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('attendance', op), error => error.reason === 'launch-unavailable');
  assert.equal(requests.some(request => request.command === 'invoke'), false);
});

test('existing NEIS landing is reused without opening a duplicate URL and is reverified', async () => {
  const requests = [];
  const opened = [];
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['portal', 'neis', 'edufine'] });
  const responses = [reply([neis]), reply([neis]), reply([neis], { invoked: true }), reply([neis])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async url => opened.push(url), pause: async () => {} });
  const op = { ...operation(), action: 'neis' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.deepEqual(opened, []);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('neis', op), { verified: true, system: 'neis', deepActionUnsupported: false });
  assert.deepEqual(requests[2], { command: 'invoke', target, action: 'activate-system-tab', system: 'neis' });
});

test('K-EdYouFine activation reuses the existing Edge tab set and waits for exact landing', async () => {
  const requests = [];
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['portal', 'neis', 'edufine'] });
  const edufine = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['portal', 'neis', 'edufine'] });
  const responses = [reply([neis]), reply([neis]), reply([edufine], { invoked: true }), reply([edufine])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => { throw new Error('must not open'); }, pause: async () => {} });
  const op = { ...operation(), action: 'edufine' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('edufine', op), { verified: true, system: 'edufine', deepActionUnsupported: false });
  assert.equal(requests.filter(request => request.command === 'invoke').length, 1);
});

test('verified K-EdYouFine landing can switch back to NEIS without reopening login', async () => {
  const requests = [];
  const opened = [];
  const edufine = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['portal', 'neis', 'edufine'] });
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['portal', 'neis', 'edufine'], neisTaskState: neisTaskState() });
  const responses = [reply([edufine]), reply([edufine]), reply([neis], { invoked: true }), reply([neis])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async url => opened.push(url), pause: async () => {} });
  const op = { ...operation(), action: 'neis' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.deepEqual(opened, []);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('neis', op), { verified: true, system: 'neis', deepActionUnsupported: false });
});

test('attendance navigation prefers an existing task tab and completes only on exact active task', async () => {
  const requests = [];
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis'], neisTaskState: neisTaskState({ existingTaskTabs: ['attendance'], actions: ['select-attendance-tab'] }) });
  const active = windowState({ ...neis, neisTaskState: neisTaskState({ existingTaskTabs: ['attendance'], activeTask: 'attendance' }) });
  const responses = [reply([neis]), reply([neis]), reply([neis], { invoked: true }), reply([neis]), reply([neis], { invoked: true }), reply([active])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = { ...operation(), action: 'attendance' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('attendance', op), { verified: true, system: 'neis', activeTask: 'attendance' });
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['activate-system-tab', 'select-attendance-tab']);
});

test('trip navigation performs one deterministic state step per reinspection', async () => {
  const requests = [];
  const base = patch => windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis'], neisTaskState: neisTaskState(patch) });
  const states = [
    base({ actions: ['select-my-menu'] }),
    base({ myMenuSelected: true, actions: ['expand-duty'] }),
    base({ myMenuSelected: true, dutyExpanded: true, visibleTasks: ['attendance', 'trip'], actions: ['open-attendance', 'open-trip'] }),
    base({ myMenuSelected: true, dutyExpanded: true, existingTaskTabs: ['trip'], activeTask: 'trip' }),
  ];
  const responses = [reply([states[0]]), reply([states[0]]), reply([states[0]], { invoked: true }), reply([states[0]])];
  for (let index = 0; index < 3; index += 1) responses.push(reply([states[index]], { invoked: true }), reply([states[index + 1]]));
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = { ...operation(), action: 'trip' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('trip', op), { verified: true, system: 'neis', activeTask: 'trip' });
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['activate-system-tab', 'select-my-menu', 'expand-duty', 'open-trip']);
});

test('unavailable or repeated NEIS task state fails without a repeated click loop', async () => {
  const requests = [];
  const stuck = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis'], neisTaskState: neisTaskState({ actions: ['select-my-menu'] }) });
  const responses = [reply([stuck]), reply([stuck]), reply([stuck], { invoked: true }), reply([stuck]), reply([stuck], { invoked: true }), reply([stuck])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = { ...operation(), action: 'attendance' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('attendance', op), error => error.reason === 'task-stalled');
  assert.equal(requests.filter(request => request.action === 'select-my-menu').length, 1);
});

test('cancellation during NEIS task reinspection prevents late completion', async () => {
  let resolveTaskInspect;
  const delayed = new Promise(resolve => { resolveTaskInspect = resolve; });
  const ready = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis'], neisTaskState: neisTaskState({ actions: ['open-trip'] }) });
  const active = windowState({ ...ready, neisTaskState: neisTaskState({ existingTaskTabs: ['trip'], activeTask: 'trip' }) });
  const responses = [reply([ready]), reply([ready]), reply([ready], { invoked: true }), reply([ready]), reply([ready], { invoked: true })];
  const adapter = new OrdinaryEdgeAdapter({ runNative: () => responses.length ? Promise.resolve(responses.shift()) : delayed, openExternal: async () => {}, pause: async () => {} });
  const op = { ...operation(), action: 'trip' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  const pending = adapter.resumeAction('trip', op);
  await new Promise(resolve => setImmediate(resolve));
  op.cancelled = true; op.cancel(); resolveTaskInspect(reply([active]));
  await assert.rejects(pending, /cancel/i);
});

test('NEIS task navigation has one bounded deadline', async () => {
  let clock = 0;
  const ready = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis'], neisTaskState: neisTaskState({ actions: ['open-attendance'] }) });
  const responses = [reply([ready]), reply([ready]), reply([ready], { invoked: true }), reply([ready]), reply([ready], { invoked: true }), reply([ready])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => responses.shift(), openExternal: async () => {}, landingTimeoutMs: 1, now: () => clock, pause: async () => { clock += 2; } });
  const op = { ...operation(), action: 'attendance' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('attendance', op), error => error.reason === 'task-timeout');
});

test('draft opens the coordinator exactly once only after verified K-EdYouFine landing', async () => {
  const coordinatorCalls = [];
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis', 'edufine'] });
  const edufine = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['neis', 'edufine'] });
  const responses = [reply([neis]), reply([neis]), reply([edufine], { invoked: true }), reply([edufine])];
  const editor = { pid: 7, hwnd: '11', processStartedAt: '2026-09-20T13:00:00.000Z', processPath: 'C:\\Program Files (x86)\\kedu\\WXSClient.exe', title: `${EXPECTED_FORM_CAPTION}...`, markers: [...REQUIRED_MARKERS], documentState: 'blank' };
  // A window that is already open is left alone; the coordinator opens its own beside it.
  const fresh = { ...editor, pid: 8, hwnd: '12', processStartedAt: '2026-09-22T02:20:00.000Z' };
  let opened = false;
  const draftHandoff = new DraftHandoffCoordinator({ pause: async () => {}, runNative: async request => {
    coordinatorCalls.push(request.command);
    if (request.command === 'open-public-form') { opened = true; return { status: 'ok', editors: [editor], invoked: true }; }
    return { status: 'ok', editors: opened ? [editor, fresh] : [editor] };
  } });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => responses.shift(), openExternal: async () => {}, pause: async () => {}, draftHandoff });
  const op = { ...operation(), action: 'draft' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('draft', op), { verified: true, system: 'edufine', editorReused: false, drafted: false });
  assert.deepEqual(coordinatorCalls.slice(0, 3), ['inspect-editors', 'open-public-form', 'inspect-editors']);
  await assert.rejects(adapter.resumeAction('draft', op), /already resumed/i);
});

test('a generated draft is written into a form the product just opened, and only then', async () => {
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis', 'edufine'] });
  const edufine = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['neis', 'edufine'] });
  const editor = { pid: 7, hwnd: '11', processStartedAt: '2026-09-20T13:00:00.000Z', processPath: 'C:\\Program Files (x86)\\kedu\\WXSClient.exe', title: `${EXPECTED_FORM_CAPTION}...`, markers: [...REQUIRED_MARKERS], documentState: 'blank' };
  const draft = { title: '교내 백일장 운영 계획', body: '1. 관련: 학교교육계획' };

  async function resume(handoff, options) {
    const responses = [reply([neis]), reply([neis]), reply([edufine], { invoked: true }), reply([edufine])];
    const adapter = new OrdinaryEdgeAdapter({ runNative: async () => responses.shift(), openExternal: async () => {}, pause: async () => {}, draftHandoff: handoff });
    const op = { ...operation(), action: 'draft' };
    await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
    assert.equal(await adapter.observeAuthenticated(op), true);
    return adapter.resumeAction('draft', op, options);
  }

  // A form this operation opened itself from 공용서식 is written into.
  const written = [];
  const filled = await resume({
    open: async () => ({ editor, reused: false, autosave: 'none' }),
    fill: async (opened, content) => { written.push(content); return { editor, filled: true }; },
  }, { draft });
  assert.equal(filled.drafted, true);
  assert.deepEqual(written, [draft]);

  // An editor that was already open belongs to the teacher: the product opens its own form
  // beside it and writes only into that new window, never into the existing one.
  const fresh = { ...editor, pid: 11704, hwnd: '5551', processStartedAt: '2026-09-22T02:20:00.0000000Z' };
  const besideCalls = [];
  let besideOpened = false;
  const besideResult = await resume(new DraftHandoffCoordinator({
    pause: async () => {},
    runNative: async request => {
      besideCalls.push(request);
      if (request.command === 'open-public-form') { besideOpened = true; return { status: 'ok', editors: [editor], invoked: true }; }
      if (request.command === 'fill-draft') return { status: 'ok', editors: [editor, fresh], filled: true };
      return { status: 'ok', editors: besideOpened ? [editor, fresh] : [editor] };
    },
  }), { draft });
  assert.equal(besideResult.drafted, true);
  const fills = besideCalls.filter(call => call.command === 'fill-draft');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].target, `${fresh.pid}|${fresh.processStartedAt}|${fresh.hwnd}`, 'only the new window is written into');
  assert.equal(besideCalls.some(call => call.command === 'focus-editor'), false);

  // Opening the menu without a draft still just opens it.
  assert.equal((await resume({ open: async () => ({ editor, reused: false, autosave: 'none' }), fill: async () => { throw new Error('must not fill'); } }, {})).drafted, false);
});

test('landing/domain mismatches are rejected as malformed native output', () => {
  assert.throws(() => validateResponse(reply([windowState({ origin: 'https://sen.eduptl.kr', landing: 'neis' })])), error => error.reason === 'invalid-response');
  assert.doesNotThrow(() => validateResponse(reply([windowState({ origin: 'https://sen.eduptl.kr', landing: null, authenticated: false, loginAvailable: true })])));
});

test('cancellation while landing verification prevents a late success', async () => {
  let resolveLanding;
  const lateLanding = new Promise(resolve => { resolveLanding = resolve; });
  const portal = windowState({ authenticated: true, availableSystems: ['portal', 'neis'] });
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['portal', 'neis'] });
  const responses = [reply([portal]), reply([portal]), reply([neis], { invoked: true })];
  const adapter = new OrdinaryEdgeAdapter({
    runNative: request => request.command === 'inspect' && responses.length === 0 ? lateLanding : Promise.resolve(responses.shift()),
    openExternal: async () => {},
    pause: async () => {},
  });
  const op = { ...operation(), action: 'neis' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  const pending = adapter.resumeAction('neis', op);
  await new Promise(resolve => setImmediate(resolve));
  op.cancelled = true;
  op.cancel();
  resolveLanding(reply([neis]));
  await assert.rejects(pending, /cancel/i);
});

test('a portal-only window launches the business system through its official portal link before activating the tab', async () => {
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['portal', 'neis', 'edufine'], availableSystems: ['portal'] });
  const loading = windowState({ origin: 'https://sen.neis.go.kr', authenticated: false, actions: [], availableSystems: ['portal'] });
  const opened = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['portal', 'neis'] });
  const responses = [
    reply([portal]),
    reply([portal]),
    reply([portal], { invoked: true }),
    reply([loading]),
    reply([opened]),
    reply([opened], { invoked: true }),
    reply([opened]),
  ];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('neis', op), { verified: true, system: 'neis', deepActionUnsupported: false });
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['neis', 'activate-system-tab']);
});

test('K-EduFine is launched from the portal the same way and reaches its verified landing', async () => {
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['portal', 'neis', 'edufine'], availableSystems: ['portal'] });
  const opened = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['portal', 'edufine'] });
  const responses = [reply([portal]), reply([portal]), reply([portal], { invoked: true }), reply([opened]), reply([opened], { invoked: true }), reply([opened])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('edufine', op), { verified: true, system: 'edufine', deepActionUnsupported: false });
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['edufine', 'activate-system-tab']);
});

test('a launch that never reaches the system fails honestly and never activates a tab', async () => {
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['portal', 'neis'], availableSystems: ['portal'] });
  const stalled = windowState({ origin: 'https://sen.neis.go.kr', authenticated: false, actions: [], availableSystems: ['portal'] });
  let clock = 0;
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => {
      requests.push(request);
      if (request.command === 'invoke') return reply([portal], { invoked: true });
      return reply([requests.length <= 2 ? portal : stalled]);
    },
    openExternal: async () => {}, pause: async () => { clock += 500; }, now: () => clock, landingTimeoutMs: 2000,
  });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('neis', op), error => error.reason === 'launch-not-arrived');
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['neis']);
});

test('a portal window that does not offer the business link is not launched at all', async () => {
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['portal'], availableSystems: ['portal'] });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return reply([portal]); }, openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('edufine', op), error => error.reason === 'launch-unavailable');
  assert.equal(requests.some(request => request.command === 'invoke'), false);
});

test('an unauthenticated portal return during launch preserves the authentication retry path', async () => {
  const portal = windowState({ authenticated: true, actions: ['portal', 'neis'], availableSystems: ['portal'] });
  const returned = windowState({ loginAvailable: true, authenticated: false, landing: null });
  const responses = [reply([portal]), reply([portal]), reply([portal], { invoked: true }), reply([returned])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => responses.shift(), openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('neis', op), error => error.code === 'needs-user' && error.reason === 'authentication-required');
});

test('draft handoff failures reach the notch as Korean guidance that stays retryable', async () => {
  const { translateDraftHandoffError } = require('../src/ordinary-edge.cjs');
  const focus = translateDraftHandoffError(Object.assign(new Error('Existing WXS editor could not be focused'), { code: 'focus-failed' }));
  assert.equal(focus.code, 'needs-user');
  assert.equal(focus.reason, 'focus-failed');
  assert.match(focus.message, /일반기안문 창/);
  assert.equal(/[A-Za-z]{4,}/.test(focus.message), false);

  const cancelled = Object.assign(new Error('Draft handoff was cancelled'), { code: 'cancelled' });
  assert.equal(translateDraftHandoffError(cancelled), cancelled);
  const unknown = Object.assign(new Error('something else'), { code: 'not-a-known-code' });
  assert.equal(translateDraftHandoffError(unknown), unknown);
  assert.equal(translateDraftHandoffError(new Error('plain')).message, 'plain');
});

test('a failing draft handoff surfaces translated guidance instead of the internal message', async () => {
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis', 'edufine'] });
  const edufine = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['neis', 'edufine'] });
  const responses = [reply([neis]), reply([edufine], { invoked: true }), reply([edufine])];
  const draftHandoff = { open: async () => { throw Object.assign(new Error('Existing WXS editor could not be focused'), { code: 'focus-failed' }); } };
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => responses.shift(), openExternal: async () => {}, pause: async () => {}, draftHandoff });
  const op = operation();
  adapter.state(op).target = { pid: target.pid, hwnd: target.hwnd, processStartedAt: target.processStartedAt };
  await assert.rejects(adapter.resumeAction('draft', op), error => error.code === 'needs-user' && error.reason === 'focus-failed' && /기안문 창/.test(error.message));
});

test('a logged-out portal window is still the surface for a business action, so login can start', async () => {
  const loginPage = windowState({ loginAvailable: true, actions: ['login'], availableSystems: ['portal'], landing: null, authenticated: false });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => reply([loginPage]), openExternal: async () => {} });
  const op = operation();
  for (const system of ['neis', 'edufine', 'portal', null]) {
    const found = await adapter.inspect(op, null, system);
    assert.ok(found, `desiredSystem ${system} must still resolve the official portal login window`);
    assert.equal(found.origin, 'https://sen.eduptl.kr');
  }
});

test('pressing a business button while logged out clicks the official login exactly once', async () => {
  const requests = [];
  const loginPage = windowState({ loginAvailable: true, actions: ['login'], availableSystems: ['portal'] });
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => { requests.push(request); return reply([loginPage], request.command === 'invoke' ? { invoked: true } : {}); },
    openExternal: async () => {}, pause: async () => {},
  });
  const op = { ...operation(), action: 'neis' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.deepEqual(requests.filter(r => r.command === 'invoke').map(r => r.action), ['login']);
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.deepEqual(requests.filter(r => r.command === 'invoke').map(r => r.action), ['login']);
});

test('a non-portal foreign window is never chosen as the login surface', async () => {
  const foreign = windowState({ origin: 'https://sen.neis.go.kr', landing: null, authenticated: false, availableSystems: [], actions: [] });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => reply([foreign]), openExternal: async () => {} });
  assert.equal(await adapter.inspect(operation(), null, 'edufine'), null);
});

function servedSpawn({ onWrite, autoAnswer = true } = {}) {
  const spawns = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const record = { file, args, options, writes: [], child };
    child.stdin = {
      write(value) {
        record.writes.push(value);
        onWrite?.(record, value);
        if (autoAnswer) setImmediate(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply([]))}\n`)));
      },
      end() {},
      on() {},
    };
    child.kill = () => { record.killed = true; return true; };
    spawns.push(record);
    return child;
  };
  return { spawn, spawns };
}

test('the served bridge reuses one helper process across calls and frames one request per line', async () => {
  const { spawn, spawns } = servedSpawn();
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'C:\app\ordinary-edge.ps1', servePath: 'C:\app\serve.ps1', spawn, timeoutMs: 1000 });
  for (let index = 0; index < 4; index += 1) assert.deepEqual(await bridge.run({ command: 'inspect' }, operation()), reply([]));
  assert.equal(spawns.length, 1, 'a single long-lived worker must serve every request');
  assert.deepEqual(spawns[0].args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\app\serve.ps1', '-Helper', 'C:\app\ordinary-edge.ps1']);
  assert.equal(spawns[0].writes.length, 4);
  for (const write of spawns[0].writes) {
    assert.ok(write.endsWith('\n'), 'each request is one line');
    assert.equal(Buffer.from(write.trim(), 'base64').toString('utf8'), '{"command":"inspect"}');
  }
});

test('a worker that dies without answering falls back to a one-shot helper run', async () => {
  const spawns = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const served = args.includes('C:\app\serve.ps1');
    child.stdin = {
      write() { setImmediate(() => child.emit('close', 1)); },
      end() { setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(reply([])))); child.emit('close', 0); }); },
      on() {},
    };
    child.kill = () => true;
    spawns.push({ args, served });
    return child;
  };
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'C:\app\ordinary-edge.ps1', servePath: 'C:\app\serve.ps1', spawn, timeoutMs: 1000 });
  assert.deepEqual(await bridge.run({ command: 'inspect' }, operation()), reply([]));
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].served, true);
  assert.equal(spawns[1].served, false, 'the fallback runs the helper directly');
});

test('a served request that times out kills the worker instead of leaving the stream desynchronised', async () => {
  const { spawn, spawns } = servedSpawn({ autoAnswer: false });
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'h.ps1', servePath: 's.ps1', spawn, timeoutMs: 40 });
  await assert.rejects(bridge.run({ command: 'inspect' }, operation()), error => error.reason === 'helper-timeout');
  assert.equal(spawns[0].killed, true);
  assert.equal(bridge.workerRunner.worker, null, 'the next call must start a fresh worker');
});

test('served requests stay serialised so ordered responses cannot be mismatched', async () => {
  const pendingWrites = [];
  const { spawn, spawns } = servedSpawn({ autoAnswer: false, onWrite: record => pendingWrites.push(record) });
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'h.ps1', servePath: 's.ps1', spawn, timeoutMs: 2000 });
  const first = bridge.run({ command: 'inspect' }, operation());
  const second = bridge.run({ command: 'inspect' }, operation());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns[0].writes.length, 1, 'the second request waits for the first response');
  spawns[0].child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply([]))}\n`));
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawns[0].writes.length, 2);
  spawns[0].child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply([]))}\n`));
  await second;
});

test('a cancelled served request never falls back to another helper run', async () => {
  const { spawn, spawns } = servedSpawn({ autoAnswer: false });
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'h.ps1', servePath: 's.ps1', spawn, timeoutMs: 2000 });
  const op = operation();
  const pending = bridge.run({ command: 'inspect' }, op);
  await new Promise(resolve => setImmediate(resolve));
  op.cancelled = true;
  op.cancel();
  await assert.rejects(pending, error => error.name === 'AuthenticationCancelledError');
  assert.equal(spawns.length, 1, 'cancellation must not spawn a fallback helper');
});

test('a vanished portal surface fails fast instead of waiting out the authentication timeout', async () => {
  let clock = 0;
  const present = windowState({ loginAvailable: true, actions: ['login'] });
  let visible = true;
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => (request.command === 'invoke' ? reply([present], { invoked: true }) : reply(visible ? [present] : [], visible ? {} : { status: 'unavailable' })),
    openExternal: async () => {}, pause: async () => { clock += 1000; }, now: () => clock, surfaceLostMs: 15000,
  });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.ok(adapter.state(op).target, 'the surface was seen once');
  visible = false;
  for (let index = 0; index < 14; index += 1) {
    assert.equal(await adapter.observeAuthenticated(op), false, 'a brief navigation gap must be tolerated');
    clock += 1000;
  }
  clock += 5000;
  await assert.rejects(adapter.observeAuthenticated(op), error => error.reason === 'surface-lost');
});

test('a surface that never appeared keeps waiting, because the browser may still be starting', async () => {
  let clock = 0;
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async () => reply([], { status: 'unavailable' }),
    openExternal: async () => {}, pause: async () => {}, now: () => clock, surfaceLostMs: 1000,
  });
  const op = operation();
  for (let index = 0; index < 5; index += 1) {
    clock += 5000;
    assert.equal(await adapter.observeAuthenticated(op), false);
  }
});

test('a screen already deep inside a system is reused instead of being re-launched', async () => {
  // Once the user had navigated into 공용서식 the K-EduFine tab is no longer on its front
  // page, and the draft button could no longer open anything.
  const requests = [];
  const deep = windowState({ origin: 'https://klef.sen.go.kr', landing: null, authenticated: false, availableSystems: ['portal', 'neis', 'edufine'], selectedSystem: 'edufine', actions: [] });
  const draftHandoff = { open: async () => ({ reused: false, autosave: 'none' }) };
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => { requests.push(request); return reply([deep], request.command === 'invoke' ? { invoked: true } : {}); },
    openExternal: async () => {}, pause: async () => {}, draftHandoff,
  });
  const op = operation();
  adapter.state(op).target = { pid: target.pid, hwnd: target.hwnd, processStartedAt: target.processStartedAt };
  const result = await adapter.resumeAction('draft', op);
  assert.equal(result.verified, true);
  assert.equal(requests.some(request => request.action === 'edufine'), false, 'no redundant launch click');
});

test('a wrong page on the right host is still not reported as arrival', async () => {
  // Being on klef.sen.go.kr is not the same as reaching K-EduFine; plain menu actions must
  // still prove they landed.
  let clock = 0;
  const errorPage = windowState({ origin: 'https://klef.sen.go.kr', landing: null, authenticated: false, availableSystems: ['portal', 'edufine'], actions: [] });
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => reply([errorPage], request.command === 'invoke' ? { invoked: true } : {}),
    openExternal: async () => {}, pause: async () => { clock += 500; }, now: () => clock, landingTimeoutMs: 3000,
  });
  const op = operation();
  adapter.state(op).target = { pid: target.pid, hwnd: target.hwnd, processStartedAt: target.processStartedAt };
  await assert.rejects(adapter.resumeAction('edufine', op), error => error.reason === 'landing-unverified');
});

test('already logged in: a portal tab elsewhere in Edge is switched to, never a new tab', async () => {
  // The helper reads only the page in front. With an unrelated page showing, inspect says
  // 'unavailable', but the tab strip still lists 업무포털 — so the product switches to it.
  const requests = [];
  const opened = [];
  const unrelated = { ...windowState(), origin: null, landing: null, availableSystems: ['portal', 'neis'], foreground: true };
  const loggedIn = windowState({ authenticated: true, actions: ['portal', 'neis'] });
  const responses = [
    { status: 'unavailable', windows: [unrelated] },
    { status: 'unavailable', windows: [unrelated] },
    reply([loggedIn], { invoked: true }),
    reply([loggedIn]),
  ];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async url => opened.push(url), pause: async () => {} });
  const op = { ...operation(), action: 'neis' };
  const result = await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.deepEqual(result, { opened: false, activatedTab: true });
  assert.deepEqual(opened, [], 'no new tab while a portal tab exists');
  assert.deepEqual(requests[2], { command: 'invoke', target, action: 'activate-system-tab', system: 'portal', requireLanding: false });
  assert.equal(await adapter.observeAuthenticated(op), true, 'the session in that tab is still alive: no login');
  assert.equal(requests.some(request => request.action === 'login'), false);
});

test('with no portal tab anywhere the portal is opened afresh, as before', async () => {
  const opened = [];
  const foreign = { ...windowState(), origin: null, landing: null, availableSystems: [] };
  const responses = [{ status: 'unavailable', windows: [foreign] }, { status: 'unavailable', windows: [foreign] }];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => responses.shift(), openExternal: async url => opened.push(url), pause: async () => {} });
  assert.deepEqual(await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', { ...operation(), action: 'neis' }), { opened: true });
  assert.deepEqual(opened, ['microsoft-edge:https://sen.eduptl.kr']);
});

test('a portal session notice is acknowledged once and the login that follows runs on the same tab', async () => {
  const requests = [];
  const expired = windowState({ sessionNotice: 'portal-session' });
  const loginPage = windowState({ loginAvailable: true });
  const responses = [reply([expired]), reply([expired], { invoked: true }), reply([loginPage]), reply([loginPage], { invoked: true })];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.deepEqual(requests[1], { command: 'invoke', target, action: 'dismiss-session-notice' });
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['dismiss-session-notice', 'login']);
});

test('a notice that comes back after being acknowledged is not pressed again', async () => {
  const requests = [];
  const expired = windowState({ sessionNotice: 'portal-session' });
  const responses = [reply([expired]), reply([expired], { invoked: true }), reply([expired])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = operation();
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(requests.filter(request => request.action === 'dismiss-session-notice').length, 1);
});

test('K-EdYouFine 사용시간 종료 during arrival is acknowledged and the landing check continues', async () => {
  const requests = [];
  const neis = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['neis', 'edufine'] });
  const ended = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: null, availableSystems: ['neis', 'edufine'], sessionNotice: 'edufine-usetime' });
  const main = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['neis', 'edufine'] });
  const responses = [reply([neis]), reply([neis]), reply([ended], { invoked: true }), reply([ended]), reply([ended], { invoked: true }), reply([main])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => {}, pause: async () => {} });
  const op = { ...operation(), action: 'edufine' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('edufine', op), { verified: true, system: 'edufine', deepActionUnsupported: false });
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['activate-system-tab', 'dismiss-session-notice']);
});

test('a teacher already working inside K-EdYouFine counts as logged in, and the draft opens from there', async () => {
  // The live page was a K-에듀파인 sub-screen: trusted origin, no landing, no logout control.
  // The widget used to poll it for five minutes waiting for a login that had long happened.
  const requests = [];
  const deep = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: null, availableSystems: ['portal', 'neis', 'edufine'], selectedSystem: 'edufine' });
  const editor = { pid: 7, hwnd: '11', processStartedAt: '2026-09-20T13:00:00.000Z', processPath: 'C:\\Program Files (x86)\\kedu\\WXSClient.exe', title: `${EXPECTED_FORM_CAPTION}...`, markers: [...REQUIRED_MARKERS], documentState: 'blank' };
  let opened = false;
  const draftHandoff = new DraftHandoffCoordinator({ pause: async () => {}, runNative: async request => {
    if (request.command === 'open-public-form') { opened = true; return { status: 'ok', editors: [], invoked: true }; }
    return { status: 'ok', editors: opened ? [editor] : [] };
  } });
  const responses = [reply([deep]), reply([deep]), reply([deep], { invoked: true }), reply([deep])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.length > 1 ? responses.shift() : responses[0]; }, openExternal: async () => { throw new Error('must not open'); }, pause: async () => {}, draftHandoff });
  const op = { ...operation(), action: 'draft' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true, 'inside K-에듀파인 is proof of login');
  assert.deepEqual(await adapter.resumeAction('draft', op), { verified: true, system: 'edufine', editorReused: false, drafted: false });
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['activate-system-tab']);
});

test('a logged-out portal page is still not mistaken for a business system', async () => {
  const loginPage = windowState({ loginAvailable: true });
  const responses = [reply([loginPage]), reply([loginPage], { invoked: true })];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => responses.shift(), openExternal: async () => {}, pause: async () => {} });
  assert.equal(await adapter.observeAuthenticated(operation()), false);
});

test('helper reasons for a refused write reach the notch as their own Korean guidance', () => {
  const { translateDraftHandoffError } = require('../src/ordinary-edge.cjs');
  const incomplete = translateDraftHandoffError(Object.assign(new Error('draft-write-incomplete:1|0'), { code: 'needs-user' }));
  assert.equal(incomplete.reason, 'draft-write-incomplete:1|0');
  assert.match(incomplete.message, /온전히 들어가지 않았습니다/);
  const dirty = translateDraftHandoffError(Object.assign(new Error('not-blank'), { code: 'needs-user' }));
  assert.match(dirty.message, /이미 내용이 있어/);
  const generic = translateDraftHandoffError(Object.assign(new Error('ocr-selector-unavailable'), { code: 'needs-user' }));
  assert.match(generic.message, /공용서식/);
});

test('a K-EdYouFine tab launched just now waits for its front page before the draft walk starts', async () => {
  // Live: the launch link opened K-에듀파인, the adapter accepted "inside the system" at once,
  // and the menu walk ran on a page that had not finished loading (menu-not-actionable).
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['portal', 'neis', 'edufine'], availableSystems: ['portal'] });
  const loading = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: null, availableSystems: ['portal', 'edufine'] });
  const main = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: 'edufine', availableSystems: ['portal', 'edufine'] });
  const seen = [];
  let clicks = 0;
  const draftHandoff = { open: async () => { seen.push('open'); return { editor: { pid: 1, hwnd: '2', processStartedAt: 't', processPath: 'C:\\Program Files (x86)\\kedu\\WXSClient.exe', title: EXPECTED_FORM_CAPTION, markers: [...REQUIRED_MARKERS], documentState: 'unknown' }, reused: false, autosave: 'none' }; } };
  const responses = [reply([portal]), reply([portal]), reply([portal], { invoked: true }), reply([loading]), reply([loading], { invoked: true }), reply([loading]), reply([loading]), reply([main])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); if (request.action === 'edufine') clicks += 1; return responses.shift(); }, openExternal: async () => {}, pause: async () => {}, draftHandoff });
  const op = { ...operation(), action: 'draft' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  const result = await adapter.resumeAction('draft', op);
  assert.equal(result.verified, true);
  assert.equal(clicks, 1, 'launched through the portal link');
  const landingChecks = requests.filter(request => request.command === 'inspect' && request.target).length;
  assert.ok(landingChecks >= 4, 'kept checking until the front page (landing) was there');
  assert.deepEqual(seen, ['open'], 'the walk started only once the page had landed');
});

test('a public-form walk that cannot see K-EdYouFine tells the user which tab to bring back', () => {
  const { translateDraftHandoffError } = require('../src/ordinary-edge.cjs');
  const hidden = translateDraftHandoffError(Object.assign(new Error('browser-or-menu-unavailable'), { code: 'needs-user' }));
  assert.equal(hidden.reason, 'browser-or-menu-unavailable');
  assert.match(hidden.message, /K-에듀파인 탭/);
  const slow = translateDraftHandoffError(Object.assign(new Error('menu-not-actionable'), { code: 'needs-user' }));
  assert.match(slow.message, /상단 메뉴/);
});

test('pressing K-EdYouFine while already inside it counts as arrival', async () => {
  // After a draft the tab sits on 공용서식: trusted origin, no front-page landing. Demanding
  // the front page reported '도착을 확인하지 못했습니다' on exactly the screen the user wanted.
  const requests = [];
  const inside = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: null, availableSystems: ['portal', 'neis', 'edufine'], selectedSystem: 'edufine' });
  const responses = [reply([inside]), reply([inside]), reply([inside], { invoked: true }), reply([inside])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.shift(); }, openExternal: async () => { throw new Error('must not open'); }, pause: async () => {} });
  const op = { ...operation(), action: 'edufine' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('edufine', op), { verified: true, system: 'edufine', deepActionUnsupported: false });
});

test('개인근무상황 and 출장 still demand the real NEIS front page', async () => {
  // Their menu walk reads neisTaskState, which only exists on the verified landing.
  const inside = windowState({ origin: 'https://sen.neis.go.kr', authenticated: false, landing: null, availableSystems: ['neis'] });
  let clock = 0;
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => reply([inside], { invoked: true }), openExternal: async () => {}, pause: async () => { clock += 2000; }, now: () => clock, landingTimeoutMs: 6000 });
  const op = { ...operation(), action: 'attendance' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  await assert.rejects(adapter.resumeAction('attendance', op), error => error.reason === 'landing-unverified');
});

test('a sub-screen counts as arrival only while the system owns the visible tab', () => {
  const { validateResponse } = require('../src/ordinary-edge.cjs');
  // The shape is accepted and constrained; an unknown value is malformed output.
  assert.doesNotThrow(() => validateResponse(reply([windowState({ origin: 'https://klef.sen.go.kr', landing: null, selectedSystem: 'edufine' })])));
  assert.doesNotThrow(() => validateResponse(reply([windowState({ selectedSystem: null })])));
  assert.throws(() => validateResponse(reply([windowState({ selectedSystem: 'mail' })])), error => error.reason === 'invalid-response');
});

test('an error page that kept the host but lost the tab name is never arrival', async () => {
  // klef.sen.go.kr with no K-에듀파인 tab selected: the browser's own failure page.
  let clock = 0;
  const broken = windowState({ origin: 'https://klef.sen.go.kr', landing: null, authenticated: false, availableSystems: ['portal', 'edufine'], selectedSystem: null });
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => reply([broken], request.command === 'invoke' ? { invoked: true } : {}),
    openExternal: async () => {}, pause: async () => { clock += 500; }, now: () => clock, landingTimeoutMs: 3000,
  });
  const op = operation();
  adapter.state(op).target = { pid: target.pid, hwnd: target.hwnd, processStartedAt: target.processStartedAt };
  await assert.rejects(adapter.resumeAction('edufine', op), error => error.reason === 'landing-unverified');
});

test('with K-EdYouFine on screen, pressing 나이스 switches tabs instead of demanding a login', async () => {
  // Being inside one business system proves the login; the requested system is reached by the
  // tab switch. This used to refuse outright: '로그인된 업무포털 화면을 찾지 못해'.
  const requests = [];
  const showingEdufine = windowState({ origin: 'https://klef.sen.go.kr', authenticated: false, landing: null, availableSystems: ['portal', 'neis', 'edufine'], selectedSystem: 'edufine' });
  const neisArrived = windowState({ origin: 'https://sen.neis.go.kr', authenticated: true, landing: 'neis', availableSystems: ['portal', 'neis', 'edufine'], selectedSystem: 'neis' });
  const responses = [reply([showingEdufine]), reply([showingEdufine]), reply([neisArrived], { invoked: true }), reply([neisArrived])];
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return responses.length > 1 ? responses.shift() : responses[0]; }, openExternal: async () => { throw new Error('must not open a new tab'); }, pause: async () => {} });
  const op = { ...operation(), action: 'neis' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), true);
  assert.deepEqual(await adapter.resumeAction('neis', op), { verified: true, system: 'neis', deepActionUnsupported: false });
  assert.deepEqual(requests.filter(request => request.command === 'invoke').map(request => request.action), ['activate-system-tab']);
});

test('a page on neither business host still has to be a logged-in portal', async () => {
  const stranger = windowState({ origin: 'https://sen.eduptl.kr', authenticated: false, landing: null, loginAvailable: false, availableSystems: [] });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => reply([stranger]), openExternal: async () => {}, pause: async () => {} });
  const op = { ...operation(), action: 'neis' };
  adapter.state(op).target = { pid: target.pid, hwnd: target.hwnd, processStartedAt: target.processStartedAt };
  await assert.rejects(adapter.resumeAction('neis', op), error => error.reason === 'portal-unavailable');
});

test('a press asks for a minimised browser to be brought back, instead of opening another tab', async () => {
  // UI Automation shows nothing for a minimised window, so discovery found no browser and the
  // product opened the portal again: with Edge put away, every press added a tab.
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['portal', 'neis'], availableSystems: ['portal', 'neis'] });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return reply([portal]); }, openExternal: async () => { throw new Error('must not open a new tab'); }, pause: async () => {} });
  const op = { ...operation(), action: 'neis' };
  assert.deepEqual(await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op), { opened: false });
  assert.equal(requests[0].restoreMinimised, true, 'the discovery pass asks for it');
});

test('only a discovery pass asks for the restore, never the polling that follows', async () => {
  const requests = [];
  const portal = windowState({ authenticated: true, actions: ['portal'] });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async request => { requests.push(request); return reply([portal]); }, openExternal: async () => {}, pause: async () => {} });
  const op = { ...operation(), action: 'portal' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  // The first observation reuses the window discovery already found; the next one re-reads it
  // by target, and those targeted polls are the ones that must not carry the flag.
  await adapter.observeAuthenticated(op);
  await adapter.observeAuthenticated(op);
  const targeted = requests.filter(request => request.target);
  assert.ok(targeted.length > 0);
  assert.ok(targeted.every(request => request.restoreMinimised === undefined), 'a bound window is restored by the helper itself, not by this flag');
});
