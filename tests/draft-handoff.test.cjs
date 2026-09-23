const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  EXPECTED_FORM_CAPTION,
  DraftHandoffCoordinator,
  DraftHandoffError,
  NativeDraftHandoffBridge,
  selectPublicFormCandidate,
  isVerifiedGeneralDraftEditor,
  requiresBlankBody,
} = require('../src/draft-handoff.cjs');

const WXS_PATH = 'C:\\Program Files (x86)\\kedu\\WXSClient.exe';
const MARKERS = ['Shell Embedding', 'Shell DocObject View', 'Internet Explorer_Server', 'AfxOleControl120u', 'HwpMainEditWnd'];

function editor(overrides = {}) {
  return {
    pid: 34296,
    hwnd: '79366442',
    processStartedAt: '2026-09-20T13:36:53.2970494Z',
    processPath: WXS_PATH,
    title: '일반기안문 서식(결재4인,협조4인)_',
    markers: MARKERS,
    documentState: 'unknown',
    ...overrides,
  };
}

// Scripted replies: once the list is down to one entry it is repeated, because the coordinator
// now keeps polling a settled editor for a quiet moment before handing it over.
const next = list => (list.length > 1 ? list.shift() : list[0]);

function reply(editors = [], overrides = {}) {
  return { status: 'ok', editors, ...overrides };
}

function operation() {
  const listeners = new Set();
  return {
    cancelled: false,
    onCancel(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancel() { this.cancelled = true; for (const listener of listeners) listener(); },
  };
}

test('no app: invokes the exact public form once and accepts one delayed new editor', async () => {
  const calls = [];
  const responses = [
    reply([]),
    reply([], { invoked: true, entry: { selector: 'uia', caption: EXPECTED_FORM_CAPTION } }),
    reply([]),
    reply([editor()]),
  ];
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => { calls.push(request); return next(responses); },
    pause: async () => {},
    timeoutMs: 100,
  });
  const result = await coordinator.open(operation());
  assert.equal(result.reused, false);
  assert.equal(result.editor.hwnd, '79366442');
  assert.equal(calls.filter(call => call.command === 'open-public-form').length, 1);
  assert.ok(calls.filter(call => call.command === 'inspect-editors').length >= 3);
});

test('an editor already open is left alone and a fresh form is opened beside it', async () => {
  // The user asked for a new window every time: a blank template they left open is neither
  // reused nor written into; the result is the window that did not exist before the click.
  const calls = [];
  const existing = editor();
  const fresh = editor({ pid: 11704, hwnd: '5551', processStartedAt: '2026-09-22T02:20:00.0000000Z' });
  const responses = [reply([existing]), reply([existing], { invoked: true, entry: { selector: 'ocr', caption: EXPECTED_FORM_CAPTION } }), reply([existing]), reply([existing, fresh])];
  const coordinator = new DraftHandoffCoordinator({ runNative: async request => { calls.push(request); return next(responses); }, pause: async () => {}, timeoutMs: 100 });
  const result = await coordinator.open(operation());
  assert.equal(result.reused, false);
  assert.equal(result.editor.hwnd, fresh.hwnd);
  assert.deepEqual(calls.map(call => call.command).slice(0, 4), ['inspect-editors', 'open-public-form', 'inspect-editors', 'inspect-editors']);
  assert.equal(calls.some(call => call.command === 'focus-editor'), false, 'nothing is done to the existing window');
});

test('existing documents of any kind never block a new form and are never the result', async () => {
  const fresh = editor({ pid: 11704, hwnd: '5551', processStartedAt: '2026-09-22T02:20:00.0000000Z' });
  for (const editors of [
    [editor({ markers: MARKERS.slice(1) })],
    [editor({ title: '무제 문서' })],
    [editor({ title: '2026 갤럭시 AI 클래스 운영' })],
    [editor(), editor({ hwnd: '79366443' })],
  ]) {
    const calls = [];
    let opened = false;
    const coordinator = new DraftHandoffCoordinator({
      runNative: async request => {
        calls.push(request);
        if (request.command === 'open-public-form') { opened = true; return reply(editors, { invoked: true }); }
        return reply(opened ? [...editors, fresh] : editors);
      }, pause: async () => {}, timeoutMs: 100,
    });
    const result = await coordinator.open(operation());
    assert.equal(result.editor.hwnd, fresh.hwnd);
    assert.equal(result.reused, false);
    assert.equal(calls.filter(call => call.command === 'open-public-form').length, 1);
  }
});

test('two new editors appearing at once is the only ambiguity left', async () => {
  const existing = editor();
  const first = editor({ pid: 11704, hwnd: '5551', processStartedAt: '2026-09-22T02:20:00.0000000Z' });
  const second = editor({ pid: 11705, hwnd: '5552', processStartedAt: '2026-09-22T02:20:01.0000000Z' });
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { opened = true; return reply([existing], { invoked: true }); }
      return reply(opened ? [existing, first, second] : [existing]);
    }, pause: async () => {}, timeoutMs: 100,
  });
  await assert.rejects(coordinator.open(operation()), error => error.code === 'ambiguous-editors');
});

test('reused PID is safe only when start time and hwnd prove a new editor identity', async () => {
  const old = editor({ documentState: 'closed' });
  const reusedPid = editor({ hwnd: '900', processStartedAt: '2026-09-20T13:37:53.2970494Z' });
  const responses = [reply([old]), reply([old], { invoked: true }), reply([reusedPid])];
  const coordinator = new DraftHandoffCoordinator({ runNative: async () => next(responses), pause: async () => {}, timeoutMs: 30 });
  assert.equal((await coordinator.open(operation())).editor.hwnd, '900');
});

test('closed transient windows are ignored while waiting for the ready editor', async () => {
  const responses = [reply([]), reply([], { invoked: true }), reply([editor({ documentState: 'closed' })]), reply([editor()])];
  const coordinator = new DraftHandoffCoordinator({ runNative: async () => next(responses), pause: async () => {}, timeoutMs: 100 });
  assert.equal((await coordinator.open(operation())).editor.documentState, 'unknown');
});

test('timeout and cancellation stop polling without another click', async () => {
  for (const cancel of [false, true]) {
    let clicks = 0;
    const op = operation();
    const coordinator = new DraftHandoffCoordinator({
      runNative: async request => {
        if (request.command === 'open-public-form') clicks += 1;
        if (cancel && request.command === 'inspect-editors' && clicks === 1) op.cancel();
        return request.command === 'open-public-form' ? reply([], { invoked: true }) : reply([]);
      },
      pause: async () => {}, timeoutMs: cancel ? 100 : 1, now: (() => { let n = 0; return () => (n += 2); })(),
    });
    await assert.rejects(coordinator.open(op), cancel ? /cancel/i : /timed out/i);
    assert.equal(clicks, 1);
  }
});

test('the same operation cannot trigger a duplicate click', async () => {
  let clicks = 0;
  const op = operation();
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { clicks += 1; return reply([], { invoked: true }); }
      return clicks ? reply([editor()]) : reply([]);
    }, pause: async () => {}, timeoutMs: 100,
  });
  await coordinator.open(op);
  await assert.rejects(coordinator.open(op), /already consumed/i);
  assert.equal(clicks, 1);
});

test('OCR selection requires exactly one exact caption and a fresh capture token', () => {
  const exact = { caption: EXPECTED_FORM_CAPTION, source: 'ocr', confidence: 0.98, captureToken: 'fresh-1', rootFingerprint: 'root-1', bounds: { x: 100, y: 200, width: 400, height: 40 } };
  const observation = { captureToken: 'fresh-1', rootFingerprint: 'root-1', currentRootFingerprint: 'root-1', overlayClear: true, dpiScale: 1.5 };
  assert.deepEqual(selectPublicFormCandidate([exact, { ...exact, caption: '일반기안문 서식(결재4인,협조8인)', bounds: { x: 100, y: 250, width: 400, height: 40 } }], observation), {
    selector: 'ocr', caption: EXPECTED_FORM_CAPTION, captureToken: 'fresh-1', point: { x: 300, y: 220 },
  });
  assert.throws(() => selectPublicFormCandidate([], observation), /unavailable/i);
  assert.throws(() => selectPublicFormCandidate([exact, { ...exact, bounds: { x: 100, y: 300, width: 400, height: 40 } }], observation), /ambiguous/i);
  assert.throws(() => selectPublicFormCandidate([{ ...exact, confidence: 0.6 }], observation), /confidence/i);
  assert.throws(() => selectPublicFormCandidate([exact], { ...observation, captureToken: 'stale' }), /stale/i);
  assert.throws(() => selectPublicFormCandidate([exact], { ...observation, currentRootFingerprint: 'root-2' }), /root changed/i);
  assert.throws(() => selectPublicFormCandidate([exact], { ...observation, overlayClear: false }), /overlay/i);
  assert.throws(() => selectPublicFormCandidate([exact], { ...observation, cancelled: true }), /cancel/i);
});

test('native bridge has a bounded owned helper lifecycle', async () => {
  let killed = 0;
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end() {} }; child.kill = () => { killed += 1; return true; };
    return child;
  };
  const bridge = new NativeDraftHandoffBridge({ helperPath: 'fixture.ps1', spawn, timeoutMs: 5 });
  await assert.rejects(bridge.run({ command: 'inspect-editors' }, operation()), /timed out/i);
  assert.equal(killed, 1);
});

test('native bridge accepts cancellationPromise and suppresses late helper output', async () => {
  let cancel;
  let killed = 0;
  let child;
  const cancellationPromise = new Promise(resolve => { cancel = resolve; });
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end() {}, on() {} }; child.kill = () => { killed += 1; return true; };
    return child;
  };
  const bridge = new NativeDraftHandoffBridge({ helperPath: 'fixture.ps1', spawn, timeoutMs: 1000 });
  const pending = bridge.run({ command: 'inspect-editors' }, { cancelled: false, cancellationPromise });
  cancel();
  await assert.rejects(pending, /cancel/i);
  child.stdout.emit('data', Buffer.from(JSON.stringify(reply([]))));
  child.emit('close', 0);
  assert.equal(killed, 1);
});

test('native bridge does not spawn for an operation already cancelled', async () => {
  let spawns = 0;
  const bridge = new NativeDraftHandoffBridge({ helperPath: 'fixture.ps1', spawn: () => { spawns += 1; throw new Error('must not spawn'); } });
  await assert.rejects(bridge.run({ command: 'focus-editor' }, { cancelled: true }), /cancel/i);
  assert.equal(spawns, 0);
});

test('native bridge contains stdin EPIPE and kills only its helper', async () => {
  let killed = 0;
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => child.stdin.emit('error', new Error('EPIPE')));
    child.kill = () => { killed += 1; return true; };
    return child;
  };
  const bridge = new NativeDraftHandoffBridge({ helperPath: 'fixture.ps1', spawn, timeoutMs: 1000 });
  await assert.rejects(bridge.run({ command: 'inspect-editors' }, {}), /EPIPE/);
  assert.equal(killed, 1);
});

test('native fixture parser exposes only public editor identity and exact selector outcomes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'draft-handoff-'));
  try {
    const fixturePath = join(directory, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify({ editors: [editor()], publicForms: [{ caption: EXPECTED_FORM_CAPTION, source: 'uia', automationId: 'public-form-standard', visible: true, enabled: true }] }));
    const helper = join(__dirname, '..', 'src', 'native', 'edufine-draft.ps1');
    const inspect = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-FixturePath', fixturePath], { input: JSON.stringify({ command: 'inspect-editors' }), encoding: 'utf8' });
    assert.equal(inspect.status, 0, inspect.stderr);
    const parsed = JSON.parse(inspect.stdout.trim());
    assert.equal(parsed.editors[0].processPath, WXS_PATH);
    assert.equal(JSON.stringify(parsed).includes('__sId'), false);
    const open = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-FixturePath', fixturePath], { input: JSON.stringify({ command: 'open-public-form', caption: EXPECTED_FORM_CAPTION }), encoding: 'utf8' });
    assert.equal(open.status, 0, open.stderr);
    assert.deepEqual(JSON.parse(open.stdout.trim()).entry, { selector: 'uia', caption: EXPECTED_FORM_CAPTION });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native Windows OCR selects the unique normalized 4-person/4-person caption from the saved public list', () => {
  const directory = mkdtempSync(join(tmpdir(), 'draft-ocr-'));
  try {
    const fixturePath = join(directory, 'fixture.json');
    const imagePath = join(__dirname, 'fixtures', 'public-form-list.png');
    const base = { editors: [], ocrImagePath: imagePath, captureToken: 'saved-public-1', rootFingerprint: 'fixture-root-1', currentRootFingerprint: 'fixture-root-1', overlayClear: true, dpiScale: 1.5 };
    writeFileSync(fixturePath, JSON.stringify(base));
    const helper = join(__dirname, '..', 'src', 'native', 'edufine-draft.ps1');
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-FixturePath', fixturePath], { input: JSON.stringify({ command: 'open-public-form', caption: EXPECTED_FORM_CAPTION }), encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout.trim());
    assert.equal(parsed.invoked, true);
    assert.deepEqual(parsed.entry, { selector: 'ocr', caption: EXPECTED_FORM_CAPTION });
    for (const [patch, reason] of [
      [{ currentRootFingerprint: 'changed-root' }, 'ocr-root-changed'],
      [{ overlayClear: false }, 'ocr-target-covered'],
      [{ ocrUnavailable: true }, 'korean-ocr-unavailable'],
    ]) {
      writeFileSync(fixturePath, JSON.stringify({ ...base, ...patch }));
      const rejected = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-FixturePath', fixturePath], { input: JSON.stringify({ command: 'open-public-form', caption: EXPECTED_FORM_CAPTION }), encoding: 'utf8', timeout: 15000 });
      assert.equal(rejected.status, 0, rejected.stderr);
      const result = JSON.parse(rejected.stdout.trim());
      assert.equal(result.status, 'needs-user');
      assert.equal(result.reason, reason);
      assert.equal(result.invoked, undefined);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the real WXS general draft window observed on this machine is accepted and reused', async () => {
  const live = {
    pid: 34296,
    hwnd: '79366442',
    processStartedAt: '2026-09-20T13:36:53.2970494Z',
    processPath: WXS_PATH,
    title: '일반기안문 서식(결재4인,협조4인)_',
    markers: ['Shell Embedding', 'Shell DocObject View', 'Internet Explorer_Server', 'AfxOleControl120u', 'HwpMainEditWnd'],
    documentState: 'unknown',
  };
  assert.equal(isVerifiedGeneralDraftEditor(live), true);
  // Even a verified blank template that is already open is left to the user; the product
  // opens its own beside it and only that new window is handed back.
  const calls = [];
  const opened = { ...live, pid: 11704, hwnd: '1576104', processStartedAt: '2026-09-22T02:21:00.0000000Z' };
  const responses = [reply([live]), reply([live], { invoked: true }), reply([live, opened])];
  const coordinator = new DraftHandoffCoordinator({ runNative: async request => { calls.push(request); return next(responses); }, pause: async () => {} });
  const result = await coordinator.open(operation());
  assert.equal(result.reused, false);
  assert.equal(result.editor.hwnd, opened.hwnd);
  assert.deepEqual(calls.map(call => call.command).slice(0, 3), ['inspect-editors', 'open-public-form', 'inspect-editors']);
});

test('a body-writing step still demands a proven blank document, which UIA cannot yet show', () => {
  const live = editor();
  assert.equal(isVerifiedGeneralDraftEditor(live), true);
  assert.equal(requiresBlankBody(live), false);
  assert.equal(requiresBlankBody(editor({ documentState: 'blank' })), true);
  assert.equal(requiresBlankBody(editor({ documentState: 'nonblank' })), false);
  assert.equal(requiresBlankBody(editor({ title: '무제 문서', documentState: 'blank' })), false);
});

test('the autosave prompt is declined with 취소 and the handoff then continues', async () => {
  // 취소 declines the recovery without deleting it, which is the normal answer.
  const blocked = editor({ dialogOpen: true });
  const clear = editor({ dialogOpen: false });
  const calls = [];
  const responses = [reply([]), reply([], { invoked: true }), reply([blocked]), reply([blocked], { invoked: true }), reply([clear])];
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => { calls.push(request); return next(responses); },
    pause: async () => {}, dialogWaitMs: 5000,
  });
  const result = await coordinator.open(operation());
  assert.equal(result.autosave, 'declined');
  assert.deepEqual(calls.map(call => call.command).slice(0, 5), ['inspect-editors', 'open-public-form', 'inspect-editors', 'decline-editor-dialog', 'inspect-editors']);
});

test('the autosave prompt of a window the user already had open is never answered', async () => {
  // Only the editor this operation opened gets its prompt declined; the user's own window
  // keeps waiting for the user.
  const theirs = editor({ dialogOpen: true });
  const ours = editor({ pid: 11704, hwnd: '5551', processStartedAt: '2026-09-22T02:20:00.0000000Z', dialogOpen: false });
  const calls = [];
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      calls.push(request);
      if (request.command === 'open-public-form') { opened = true; return reply([theirs], { invoked: true }); }
      return reply(opened ? [theirs, ours] : [theirs]);
    }, pause: async () => {},
  });
  const result = await coordinator.open(operation());
  assert.equal(result.editor.hwnd, ours.hwnd);
  assert.equal(result.autosave, 'none');
  assert.equal(calls.some(call => call.command === 'decline-editor-dialog'), false);
});

test('a dialog that never clears is handed back instead of being forced', async () => {
  const stuck = editor({ dialogOpen: true });
  let clock = 0;
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { opened = true; return reply([], { invoked: true }); }
      if (request.command === 'decline-editor-dialog') return reply([stuck], { invoked: false });
      return reply(opened ? [stuck] : []);
    },
    pause: async () => { clock += 500; }, now: () => clock, dialogWaitMs: 3000,
  });
  await assert.rejects(coordinator.open(operation()), error => error.code === 'editor-dialog');
});

test('a prompt the user answered themselves leaves the document unfillable', async () => {
  const { canFillBody } = require('../src/draft-handoff.cjs');
  const clear = editor({ dialogOpen: false });
  assert.equal(canFillBody({ editor: clear, reused: false, autosave: 'none' }), true);
  assert.equal(canFillBody({ editor: clear, reused: false, autosave: 'declined' }), true);
  assert.equal(canFillBody({ editor: clear, reused: false, autosave: 'user-answered' }), false, 'unknown content');
  assert.equal(canFillBody({ editor: clear, reused: true, autosave: 'none' }), false, 'the user’s own editor');
});

test('a normal editor is unaffected by the dialog guard', async () => {
  const calm = editor({ dialogOpen: false });
  const responses = [reply([]), reply([], { invoked: true }), reply([calm])];
  const coordinator = new DraftHandoffCoordinator({ runNative: async () => next(responses), pause: async () => {} });
  const result = await coordinator.open(operation());
  assert.equal(result.reused, false);
  assert.equal(result.autosave, 'none');
});

test('the dialog flag must be a boolean when present', () => {
  const { validateNativeResponse } = require('../src/draft-handoff.cjs');
  assert.throws(() => validateNativeResponse({ status: 'ok', editors: [{ ...editor(), dialogOpen: 'yes' }] }), /Invalid native draft handoff response/);
  assert.equal(validateNativeResponse({ status: 'ok', editors: [editor()] }).editors[0].dialogOpen, false);
});

test('the wait for the editor starts after the form click, not before the menu walk', async () => {
  // Opening 공용서식 walks menus and runs OCR, which used to consume the whole budget and
  // leave no time for the editor to appear.
  let clock = 0;
  const slowNavigation = 9000;
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { clock += slowNavigation; opened = true; return reply([], { invoked: true }); }
      if (!opened) return reply([]);
      return clock > 9000 + 6000 ? reply([editor()]) : reply([]);
    },
    pause: async () => { clock += 500; },
    now: () => clock,
    timeoutMs: 8000,
    editorWaitMs: 25000,
  });
  const result = await coordinator.open(operation());
  assert.equal(result.reused, false, 'the editor that appeared after the slow walk is still accepted');
});

test('a window that has only just appeared is given time to become recognisable', async () => {
  // Right after it appears the editor has not taken its title yet; failing at that instant
  // rejected a perfectly good draft form.
  let clock = 0;
  let polls = 0;
  const half = editor({ title: '', markers: [] });
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') return reply([], { invoked: true });
      polls += 1;
      if (polls <= 2) return reply([]);
      return reply([polls <= 5 ? half : editor()]);
    },
    pause: async () => { clock += 200; }, now: () => clock, editorWaitMs: 20000,
  });
  const result = await coordinator.open(operation());
  assert.equal(result.reused, false);
  assert.equal(result.editor.title, '일반기안문 서식(결재4인,협조4인)_');
});

test('a window that never becomes a draft form is still refused', async () => {
  let clock = 0;
  const wrong = editor({ title: '무제 문서', markers: [] });
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { opened = true; return reply([], { invoked: true }); }
      return reply(opened ? [wrong] : []);
    },
    pause: async () => { clock += 500; }, now: () => clock, editorWaitMs: 3000,
  });
  await assert.rejects(coordinator.open(operation()), error => error.code === 'unsafe-new-editor');
});

test('a generated draft is written only into a form this operation opened', async () => {
  const clear = editor({ dialogOpen: false });
  const sent = [];
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => { sent.push(request); return reply([clear], { filled: true }); },
  });
  const opened = { editor: clear, reused: false, autosave: 'none' };

  const done = await coordinator.fill(opened, { title: '교내 백일장 운영 계획', body: '1. 관련: ...' }, operation());
  assert.equal(done.filled, true);
  // A look at the editor precedes the write (a late prompt would swallow it); the write itself
  // carries exactly the content and the fingerprint of the window this operation opened.
  assert.deepEqual(sent.filter(request => request.command === 'fill-draft'), [{
    command: 'fill-draft',
    target: `${clear.pid}|${clear.processStartedAt}|${clear.hwnd}`,
    title: '교내 백일장 운영 계획',
    body: '1. 관련: ...',
  }]);

  // The user's own editor, and one whose recovery prompt they answered themselves, stay untouched.
  for (const unsafe of [{ editor: clear, reused: true, autosave: 'none' },
                        { editor: clear, reused: false, autosave: 'user-answered' }]) {
    await assert.rejects(coordinator.fill(unsafe, { title: 'x', body: 'y' }, operation()),
      error => error.code === 'not-fillable');
  }
});

test('a draft the helper could not finish writing is never reported as written', async () => {
  const clear = editor({ dialogOpen: false });
  const opened = { editor: clear, reused: false, autosave: 'none' };

  const refused = new DraftHandoffCoordinator({
    runNative: async () => ({ status: 'needs-user', editors: [clear], filled: false, reason: 'not-blank' }),
  });
  await assert.rejects(refused.fill(opened, { title: 'a', body: 'b' }, operation()),
    error => error.code === 'needs-user' && /not-blank/.test(error.message));

  const partial = new DraftHandoffCoordinator({ runNative: async () => reply([clear], { filled: false }) });
  await assert.rejects(partial.fill(opened, { title: 'a', body: 'b' }, operation()),
    error => error.code === 'not-filled');

  for (const bad of [{ title: '', body: 'b' }, { title: 'a', body: '   ' }, { title: 'a', body: 'x'.repeat(20001) }]) {
    const coordinator = new DraftHandoffCoordinator({ runNative: async () => reply([clear], { filled: true }) });
    await assert.rejects(coordinator.fill(opened, bad, operation()), error => error.code === 'invalid-content');
  }
});

test('the helper escapes every non-ASCII character it sends into the editor page', () => {
  // The Korean a teacher types must survive whatever code page the helper is launched with,
  // so the script it builds carries unicode escapes rather than raw text.
  const helper = join(__dirname, '..', 'src', 'native', 'edufine-draft.ps1');
  const source = require('node:fs').readFileSync(helper, 'utf8');
  const builder = source.slice(source.indexOf('function ConvertTo-JsStringLiteral'));
  const escapeFormat = String.fromCharCode(92) + 'u{0:x4}';  // a backslash-u escape, spelled out so this file needs none
  assert.ok(builder.includes(escapeFormat), 'non-ASCII must be emitted as a unicode escape');
  assert.match(source, /IMPL_PutFieldText\(W, TITLE_FIELD, TITLE_TEXT\)/);
  // execScript returns a value. Left unassigned it joins the function's output and the reply
  // string stops being a string, which took a live editor to notice.
  assert.ok(source.includes('$null = $Document.parentWindow.execScript'), 'the execScript return value must be discarded');
  // PutFieldText drops line breaks. A 기안문 body written that way runs into one paragraph,
  // so the body goes in through a select-then-insert instead, and the write is verified
  // against the document's own text rather than the field readback.
  assert.ok(!source.includes('IMPL_PutFieldText(W, BODY_FIELD'), 'the body must not go through PutFieldText');
  // The move follows the page's own idiom: document start, then the two-argument MoveToField,
  // whose result is checked — the five-argument string form never moved (observed live).
  assert.ok(source.includes('IMPL_MovePos(W, 2, 0, 0)'));
  assert.ok(source.includes('IMPL_MoveToField(W, BODY_FIELD) !== true'));
  assert.ok(!source.includes("IMPL_MoveToField(W, BODY_FIELD, 'text'"));
  // InsertText makes a paragraph only of CRLF and drops a bare LF (observed live), so every
  // line break is normalised before the insert.
  assert.ok(source.includes("IMPL_InsertText(W, BODY_TEXT.replace(/\\r\\n|\\r|\\n/g, '\\r\\n'))"));
  assert.ok(source.includes("GetTextFile('TEXT', '')"), 'the paragraph check must read the document back');

  // Saving or submitting is the teacher's decision, never the product's.
  for (const forbidden of ['IMPL_SaveDocument', 'docSave', 'fncFileSave', 'IMPL_SaveToPDF']) {
    assert.ok(!source.includes(forbidden), `the helper must never call ${forbidden}`);
  }
});

test('a second editor asking to close the first is answered 취소 and still opened', async () => {
  // '열려있는 기안/결재기를 닫습니다' — 확인 would close the user's editor. 취소 keeps it and the
  // new one opens anyway (observed live), so the product presses 취소 and carries on.
  const theirs = editor();
  const asking = editor({ pid: 18420, hwnd: '1576726', processStartedAt: '2026-09-22T02:59:36.0000000Z', title: '____', markers: [], dialogOpen: true, dialogKind: 'close-other' });
  const recovering = { ...asking, title: '', dialogOpen: true, dialogKind: 'autosave' };
  const ready = { ...asking, title: '일반기안문 서식(결재4인,협조4인)_', markers: MARKERS, dialogOpen: false, dialogKind: null };
  const calls = [];
  const stages = [[theirs, asking], [theirs, recovering], [theirs, ready]];
  let stage = 0;
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      calls.push(request.command);
      if (request.command === 'open-public-form') { opened = true; return reply([theirs], { invoked: true }); }
      if (request.command === 'decline-editor-dialog') { stage += 1; return reply(stages[stage], { invoked: true }); }
      return reply(opened ? stages[stage] : [theirs]);
    }, pause: async () => {}, dialogWaitMs: 5000,
  });
  const result = await coordinator.open(operation());
  assert.equal(result.editor.pid, 18420);
  assert.equal(result.reused, false);
  assert.equal(result.autosave, 'declined');
  assert.equal(calls.filter(command => command === 'decline-editor-dialog').length, 2, 'close-other, then autosave');
});

test('the close-other prompt alone leaves the autosave state untouched', async () => {
  const asking = editor({ pid: 18420, hwnd: '1576726', processStartedAt: '2026-09-22T02:59:36.0000000Z', dialogOpen: true, dialogKind: 'close-other' });
  const ready = { ...asking, dialogOpen: false, dialogKind: null };
  let opened = false;
  let declined = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { opened = true; return reply([], { invoked: true }); }
      if (request.command === 'decline-editor-dialog') { declined = true; return reply([ready], { invoked: true }); }
      return reply(opened ? [declined ? ready : asking] : []);
    }, pause: async () => {},
  });
  const result = await coordinator.open(operation());
  assert.equal(result.autosave, 'none');
  assert.equal(canFillBodyOf(result), true);
});

function canFillBodyOf(result) { return require('../src/draft-handoff.cjs').canFillBody(result); }

test('an unknown prompt kind is refused as malformed helper output', () => {
  const { validateNativeResponse } = require('../src/draft-handoff.cjs');
  assert.throws(() => validateNativeResponse(reply([editor({ dialogOpen: true, dialogKind: 'confirm-anything' })])), error => error.code === 'invalid-response');
  assert.equal(validateNativeResponse(reply([editor({ dialogOpen: true })])).editors[0].dialogKind, 'autosave', 'older helpers only knew the autosave prompt');
});

test('a prompt that surfaces after the window looked ready is settled before the handover', async () => {
  // Live: '열려있는 기안/결재기를 닫습니다' was answered, the window verified, and only then
  // the autosave question appeared — right where the draft was being written.
  const fresh = editor({ pid: 21756, hwnd: '3804438', processStartedAt: '2026-09-22T03:33:17.0000000Z' });
  const calls = [];
  let polls = 0;
  let opened = false;
  let declined = 0;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      calls.push(request.command);
      if (request.command === 'open-public-form') { opened = true; return reply([], { invoked: true }); }
      if (request.command === 'decline-editor-dialog') { declined += 1; return reply([{ ...fresh, dialogOpen: false }], { invoked: true }); }
      if (!opened) return reply([]);
      polls += 1;
      // ready at first, then the late autosave prompt on the 2nd quiet poll, then calm again
      const late = polls === 3 && declined === 0;
      return reply([{ ...fresh, dialogOpen: late, dialogKind: late ? 'autosave' : null }]);
    }, pause: async () => {},
  });
  const result = await coordinator.open(operation());
  assert.equal(result.editor.pid, 21756);
  assert.equal(result.autosave, 'declined', 'the late prompt was answered and recorded');
  assert.equal(declined, 1);
  assert.ok(calls.filter(command => command === 'inspect-editors').length >= 5, 'quiet polls happened after verification');
});

test('a write is preceded by settling any prompt that came up since the open', async () => {
  const fresh = editor({ pid: 21756, hwnd: '3804438', processStartedAt: '2026-09-22T03:33:17.0000000Z' });
  const calls = [];
  let declined = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      calls.push(request.command);
      if (request.command === 'decline-editor-dialog') { declined = true; return reply([fresh], { invoked: true }); }
      if (request.command === 'fill-draft') return reply([fresh], { filled: true });
      return reply([{ ...fresh, dialogOpen: !declined, dialogKind: declined ? null : 'autosave' }]);
    }, pause: async () => {},
  });
  const opened = { editor: fresh, reused: false, autosave: 'none' };
  const result = await coordinator.fill(opened, { title: '제목', body: '본문' }, operation());
  assert.equal(result.filled, true);
  assert.deepEqual(calls, ['inspect-editors', 'decline-editor-dialog', 'inspect-editors', 'fill-draft']);
});

test('a helper timeout while the editor loads is retried, not fatal', async () => {
  // The editor stops answering window messages for a moment as it opens its document. One
  // timeout there used to end the handoff although the window was there and fine.
  const fresh = editor({ pid: 26728, hwnd: '7771', processStartedAt: '2026-09-22T04:40:00.0000000Z' });
  let clock = 0;
  let polls = 0;
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { opened = true; return reply([], { invoked: true }); }
      polls += 1;
      if (opened && polls >= 2 && polls <= 4) throw new DraftHandoffError('timeout', 'Native draft handoff helper timed out');
      return reply(opened && polls > 4 ? [fresh] : []);
    },
    pause: async () => { clock += 100; }, now: () => clock, editorWaitMs: 45000,
  });
  const result = await coordinator.open(operation());
  assert.equal(result.editor.pid, 26728);
  assert.ok(polls > 4, 'the retries happened');
});

test('a helper timeout that outlasts the whole wait is still reported', async () => {
  let clock = 0;
  let opened = false;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { opened = true; return reply([], { invoked: true }); }
      if (opened) throw new DraftHandoffError('timeout', 'Native draft handoff helper timed out');
      return reply([]);
    },
    pause: async () => { clock += 500; }, now: () => clock, editorWaitMs: 2000,
  });
  await assert.rejects(coordinator.open(operation()), error => error.code === 'timeout');
});

test('a non-transient helper failure during the wait is not retried away', async () => {
  let opened = false;
  let polls = 0;
  const coordinator = new DraftHandoffCoordinator({
    runNative: async request => {
      if (request.command === 'open-public-form') { opened = true; return reply([], { invoked: true }); }
      polls += 1;
      if (opened) throw new DraftHandoffError('invalid-response', 'Invalid native draft handoff response');
      return reply([]);
    }, pause: async () => {}, editorWaitMs: 45000,
  });
  await assert.rejects(coordinator.open(operation()), error => error.code === 'invalid-response');
  assert.equal(polls, 2, 'one look before the click, one after — no retry loop on malformed output');
});
