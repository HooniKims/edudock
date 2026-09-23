'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { buildSteps, GuideSession, shouldAutoStart, PASSWORD_STEP } = require('../src/guide.cjs');
const { SecretStore } = require('../src/secret-store.cjs');
const { sanitizedSettings } = require('../src/settings.cjs');

test('the walkthrough follows the user’s own button order and always ends at settings', () => {
  const steps = buildSteps({ buttons: ['trip', 'neis', 'compose'] });
  assert.deepEqual(steps.filter(step => step.kind === 'button').map(step => step.button), ['trip', 'neis', 'compose', 'settings']);
  assert.equal(steps.at(-1).id, 'password');
});

test('unknown or repeated buttons never produce a step, and every step names a real control', () => {
  const steps = buildSteps({ buttons: ['neis', 'neis', 'nonsense', 'settings', 'edufine'] });
  assert.deepEqual(steps.filter(step => step.kind === 'button').map(step => step.button), ['neis', 'settings', 'edufine']);
  for (const step of steps) {
    assert.ok(step.title && step.body, 'a step without text would show an empty popover');
    if (step.kind === 'button') assert.ok(step.button);
  }
});

test('the password offer is dropped when there is nothing to offer', () => {
  const steps = buildSteps({ buttons: ['neis'], includePasswordOffer: false });
  assert.equal(steps.some(step => step.id === 'password'), false);
  assert.equal(steps.at(-1).button, 'settings');
});

test('a session walks forward once per step and reports the last step before finishing', () => {
  const session = new GuideSession({ buttons: ['neis', 'edufine'] });
  const seen = [];
  let step = session.current();
  while (step) {
    seen.push(step.id);
    assert.equal(step.total, session.steps.length);
    assert.equal(step.last, step.index === session.steps.length - 1);
    step = session.next();
  }
  assert.deepEqual(seen, ['neis', 'edufine', 'settings', 'password']);
  assert.equal(session.finished, true);
  assert.equal(session.outcome, 'completed');
  assert.equal(session.next(), null);
});

test('skipping ends the walkthrough immediately and is remembered as seen', () => {
  const session = new GuideSession({ buttons: ['neis', 'edufine'] });
  assert.equal(session.current().id, 'neis');
  assert.equal(session.skip(), null);
  assert.equal(session.finished, true);
  assert.equal(session.outcome, 'skipped');
  assert.equal(session.current(), null);
  assert.equal(shouldAutoStart({ guideCompleted: true }), false);
});

test('the walkthrough starts itself only until it has been seen once', () => {
  assert.equal(shouldAutoStart(sanitizedSettings({})), true);
  assert.equal(shouldAutoStart(sanitizedSettings({ guideCompleted: true })), false);
  assert.equal(shouldAutoStart(undefined), true);
});

test('the password offer states where the secret is kept', () => {
  assert.match(PASSWORD_STEP.body, /안전하게 보관/);
  assert.equal(PASSWORD_STEP.kind, 'password-offer');
});

function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    // Obscures the plain text the way a real keyring would, so the on-disk assertion means something.
    encryptString: plain => Buffer.concat([Buffer.from('EDK1', 'utf8'), Buffer.from(plain, 'utf8').map(byte => byte ^ 0x5a)]),
    decryptString: buffer => {
      if (buffer.length < 4 || buffer.subarray(0, 4).toString('utf8') !== 'EDK1') throw new Error('not ours');
      return Buffer.from(buffer.subarray(4)).map(byte => byte ^ 0x5a).toString('utf8');
    },
  };
}

test('a saved certificate password is written only as ciphertext and reads back', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edudock-secret-'));
  try {
    const store = new SecretStore({ directory, safeStorage: fakeSafeStorage() });
    assert.equal(store.has(), false);
    assert.equal(store.load(), null);
    store.save('pa55word!');
    assert.equal(store.has(), true);
    const onDisk = readFileSync(store.file);
    assert.equal(onDisk.includes('pa55word!'), false, 'the plain secret must never touch the disk');
    assert.equal(store.load(), 'pa55word!');
    assert.equal(store.clear(), true);
    assert.equal(store.has(), false);
    assert.equal(store.load(), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a secret that this account cannot decrypt is treated as absent, not as an error', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edudock-secret-'));
  try {
    const store = new SecretStore({ directory, safeStorage: fakeSafeStorage() });
    store.save('x');
    writeFileSync(store.file, Buffer.from('someone-elses-ciphertext', 'utf8'));
    assert.equal(store.load(), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('without OS encryption the store refuses to save rather than falling back to plain text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edudock-secret-'));
  try {
    const store = new SecretStore({ directory, safeStorage: fakeSafeStorage({ available: false }) });
    assert.throws(() => store.save('secret'), /안전하게 저장할 수 없습니다/);
    assert.equal(existsSync(store.file), false);
    assert.equal(store.load(), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('empty and oversized secrets are rejected before any write', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edudock-secret-'));
  try {
    const store = new SecretStore({ directory, safeStorage: fakeSafeStorage() });
    for (const bad of ['', 'x'.repeat(257), null, 12345]) assert.throws(() => store.save(bad), /올바르지 않습니다/);
    assert.equal(existsSync(store.file), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('settings remember that the guide was seen and that a password exists, but never the password', () => {
  const settings = sanitizedSettings({ guideCompleted: true, passwordSaved: true, autoLogin: true, schemaVersion: 4 });
  assert.equal(settings.guideCompleted, true);
  assert.equal(settings.passwordSaved, true);
  // The marker is a boolean; a secret must never be carried in settings under any key.
  assert.equal(typeof settings.passwordSaved, 'boolean');
  const carried = sanitizedSettings({ ...settings, certificatePassword: 'pa55word!', password: 'pa55word!' });
  assert.equal(JSON.stringify(carried).includes('pa55word!'), false);
  assert.equal(Object.hasOwn(carried, 'certificatePassword'), false);
  assert.equal(Object.hasOwn(carried, 'password'), false);
  const fresh = sanitizedSettings({});
  assert.equal(fresh.guideCompleted, false);
  assert.equal(fresh.passwordSaved, false);
});

const { OrdinaryEdgeAdapter } = require('../src/ordinary-edge.cjs');

const target = { pid: 4312, hwnd: '9988', processStartedAt: '2026-09-20T10:00:00.0000000Z' };
const certificate = (patch = {}) => ({
  visible: false, hardDiskAvailable: false, removableAvailable: false, selectedStore: null, hardDiskEmpty: null,
  driveOptions: [], driveOptionsToken: null, selectedDriveId: null, certRowCount: null, selectedCertRowCount: null,
  soleCertRowSelectable: false, ...patch,
});
const windowState = (patch = {}) => ({
  ...target, origin: 'https://sen.eduptl.kr', authenticated: false, loginAvailable: false, certificate: certificate(),
  actions: [], landing: patch.authenticated === true ? 'portal' : null, availableSystems: ['portal'], ...patch,
});
const reply = (windows, patch = {}) => ({ status: 'ok', windows, ...patch });
const operation = () => {
  let cancel;
  const cancellation = new Promise(resolve => { cancel = resolve; });
  return { cancelled: false, cancellation, cancel };
};
const chosen = () => windowState({ certificate: certificate({ visible: true, selectedStore: 'removable-disk', certRowCount: 1, selectedCertRowCount: 1 }) });

test('a stored password is submitted once, and the secret never appears in the request log', async () => {
  const requests = [];
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => { requests.push(request); return reply([chosen()], request.command === 'invoke' ? { invoked: true } : {}); },
    openExternal: async () => {}, pause: async () => {}, getStoredPassword: () => 'pa55word!',
  });
  const op = operation();
  adapter.state(op).target = target;
  assert.equal(await adapter.observeAuthenticated(op), false);
  const submits = requests.filter(request => request.action === 'submit-certificate-password');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].password, 'pa55word!', 'the helper still receives it');
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(requests.filter(request => request.action === 'submit-certificate-password').length, 1, 'never retried');
});

test('no stored password means the user is simply left at the password box', async () => {
  const requests = [];
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => { requests.push(request); return reply([chosen()]); },
    openExternal: async () => {}, pause: async () => {}, getStoredPassword: () => null,
  });
  const op = operation();
  adapter.state(op).target = target;
  assert.equal(await adapter.observeAuthenticated(op), false);
  assert.equal(requests.some(request => request.command === 'invoke'), false);
});

test('a rejected stored password is cleared and explained instead of being tried again', async () => {
  let cleared = 0;
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async request => (request.command === 'invoke' ? reply([chosen()], { invoked: false }) : reply([chosen()])),
    openExternal: async () => {}, pause: async () => {}, getStoredPassword: () => 'wrong', onPasswordRejected: () => { cleared += 1; },
  });
  const op = operation();
  adapter.state(op).target = target;
  await assert.rejects(adapter.observeAuthenticated(op), error => error.reason === 'stored-password-failed');
  assert.equal(cleared, 1);
});

test('an empty or oversized password is refused before it reaches the helper', async () => {
  const { validateResponse } = require('../src/ordinary-edge.cjs');
  assert.ok(validateResponse);
  for (const bad of ['', 'x'.repeat(257), 42, null]) {
    const adapter = new OrdinaryEdgeAdapter({
      runNative: async request => { assert.notEqual(request.action, 'submit-certificate-password', 'must not be sent'); return reply([chosen()]); },
      openExternal: async () => {}, pause: async () => {}, getStoredPassword: () => bad,
    });
    const op = operation();
    adapter.state(op).target = target;
    assert.equal(await adapter.observeAuthenticated(op), false);
  }
});

const { PortalAutomation } = require('../src/portal.cjs');

function automationHarness({ now = () => 0 } = {}) {
  const events = [];
  const automation = new PortalAutomation({
    status: data => events.push(data.phase),
    openPortal: () => new Promise(() => {}),
    observeAuthenticated: () => new Promise(() => {}),
    resumeAction: () => new Promise(() => {}),
    now,
  });
  return { automation, events };
}

test('a work button never stays locked: a later press replaces the running task', async () => {
  let clock = 0;
  const { automation, events } = automationHarness({ now: () => clock });
  const first = automation.openMenu('neis');
  assert.equal(automation.busy, true);
  clock += 5000;
  const second = automation.openMenu('trip');
  assert.equal(automation.operation?.action, 'trip', 'the new press owns the widget now');
  assert.equal(events.includes('cancelled'), true, 'the abandoned task is cancelled, not left hanging');
  automation.cancel();
  await Promise.allSettled([first, second]);
});

test('an accidental double press is still swallowed', async () => {
  let clock = 0;
  const { automation } = automationHarness({ now: () => clock });
  const first = automation.openMenu('neis');
  clock += 300;
  assert.deepEqual(await automation.openMenu('neis'), { ok: false, message: '이전 작업이 진행 중입니다.' });
  assert.equal(automation.operation?.action, 'neis');
  automation.cancel();
  await Promise.allSettled([first]);
});

test('a flow that never reaches the portal gives up instead of holding the buttons', async () => {
  let clock = 0;
  const adapter = new OrdinaryEdgeAdapter({
    runNative: async () => reply([], { status: 'unavailable' }),
    openExternal: async () => {}, pause: async () => {}, now: () => clock, surfaceMissingMs: 45000,
  });
  const op = { ...operation(), action: 'neis' };
  await adapter.openOfficialPortal('microsoft-edge:https://sen.eduptl.kr', op);
  assert.equal(await adapter.observeAuthenticated(op), false, 'Edge may still be starting');
  clock += 44000;
  assert.equal(await adapter.observeAuthenticated(op), false);
  clock += 2000;
  await assert.rejects(adapter.observeAuthenticated(op), error => error.reason === 'surface-missing');
});

test('when the portal opens a second window the one in front is used', async () => {
  const background = windowState({ authenticated: true, actions: ['portal', 'neis'], foreground: false });
  const front = windowState({ authenticated: true, actions: ['portal', 'neis'], hwnd: '7777', foreground: true });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => reply([background, front]), openExternal: async () => {} });
  const picked = await adapter.inspect(operation(), null, 'neis');
  assert.equal(picked.hwnd, '7777');
});

test('two equally plausible windows still refuse rather than guessing', async () => {
  const one = windowState({ authenticated: true, actions: ['portal'], foreground: false });
  const two = windowState({ authenticated: true, actions: ['portal'], hwnd: '7777', foreground: false });
  const adapter = new OrdinaryEdgeAdapter({ runNative: async () => reply([one, two]), openExternal: async () => {} });
  await assert.rejects(adapter.inspect(operation(), null, 'portal'), error => error.reason === 'ambiguous-window');
});

test('the draft handoff reuses one helper process instead of spawning per poll', async () => {
  const { NativeDraftHandoffBridge } = require('../src/draft-handoff.cjs');
  const spawns = [];
  const spawn = (file, args) => {
    const child = new (require('node:events').EventEmitter)();
    child.stdout = new (require('node:events').EventEmitter)();
    child.stderr = new (require('node:events').EventEmitter)();
    const record = { args, writes: [] };
    child.stdin = {
      write(value) {
        record.writes.push(value);
        setImmediate(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ status: 'ok', editors: [] })}\n`)));
      },
      end() {}, on() {},
    };
    child.kill = () => true;
    spawns.push(record);
    return child;
  };
  const bridge = new NativeDraftHandoffBridge({ helperPath: 'h.ps1', servePath: 's.ps1', spawn, timeoutMs: 1000 });
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await bridge.run({ command: 'inspect-editors' }, {}), { status: 'ok', editors: [] });
  }
  assert.equal(spawns.length, 1, 'polling must not start a process per request');
  assert.deepEqual(spawns[0].args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 's.ps1', '-Helper', 'h.ps1']);
  assert.equal(spawns[0].writes.length, 5);
  assert.equal(Buffer.from(spawns[0].writes[0].trim(), 'base64').toString('utf8'), '{"command":"inspect-editors"}');
  bridge.stopWorker();
});

test('a draft worker that dies without answering falls back to a direct helper run', async () => {
  const { NativeDraftHandoffBridge } = require('../src/draft-handoff.cjs');
  const { EventEmitter } = require('node:events');
  const kinds = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const served = args.includes('s.ps1');
    kinds.push(served ? 'served' : 'direct');
    child.stdin = {
      write() { setImmediate(() => child.emit('close', 1)); },
      end() { setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ status: 'ok', editors: [] }))); child.emit('close', 0); }); },
      on() {},
    };
    child.kill = () => true;
    return child;
  };
  const bridge = new NativeDraftHandoffBridge({ helperPath: 'h.ps1', servePath: 's.ps1', spawn, timeoutMs: 1000 });
  assert.deepEqual(await bridge.run({ command: 'inspect-editors' }, {}), { status: 'ok', editors: [] });
  assert.deepEqual(kinds, ['served', 'direct']);
});
