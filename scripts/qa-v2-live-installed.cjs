'use strict';

// Drives the INSTALLED widget through its real menus (login → NEIS → 개인근무상황 → 출장 →
// 일반기안) using the product's own IPC, and records how every native step was performed.
// Nothing is filled, saved or submitted. Secrets are never read or written by this script.
//
//   node scripts/qa-v2-live-installed.cjs [--menus neis,attendance,trip,draft] [--exe <path>]

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const menus = option('--menus', 'neis,attendance,trip,draft').split(',').map(item => item.trim()).filter(Boolean);
const executablePath = option('--exe', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'EduDock', 'EduDock.exe'));
const perMenuTimeoutMs = Number(option('--timeout', 300000));
const evidence = path.join(root, 'artifacts', 'qa', 'v2', '13-live-installed', `attempt-${Date.now()}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function redact(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s)]+/gi, '[URL]').replace(/__sId=[^&\s]+/gi, '__sId=[REDACTED]').slice(0, 300);
}

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const report = { invocation: `node scripts/qa-v2-live-installed.cjs --menus ${menus.join(',')}`, executablePath, startedAt: new Date().toISOString(), menus: {}, nativeCalls: [], pass: false };
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.EDUDOCK_QA_PROFILE;
  const app = await electron.launch({ executablePath, args: [], env });
  try {
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    await notch.waitForFunction(() => Boolean(window.portal));

    // Record every native helper round trip (action/command, status, and the helper's own
    // account of how it pressed things) by wrapping the bridge classes the app already loaded.
    await app.evaluate(async (_electron, modulePaths) => {
      const load = process.getBuiltinModule('module').createRequire(modulePaths.ordinary);
      const { NativeOrdinaryEdgeBridge } = load(modulePaths.ordinary);
      const { NativeDraftHandoffBridge } = load(modulePaths.draft);
      globalThis.__liveNativeCalls = [];
      const record = (kind, request, response, error, ms) => {
        const entry = { kind, at: new Date().toISOString(), ms, request: { command: request?.command, action: request?.action, system: request?.system } };
        if (response) {
          entry.status = response.status;
          if (response.invoked !== undefined) entry.invoked = response.invoked;
          if (response.method !== undefined) entry.method = response.method;
          if (response.entry !== undefined) entry.entry = response.entry;
          if (response.presses !== undefined) entry.presses = response.presses;
          if (response.focused !== undefined) entry.focused = response.focused;
          if (response.filled !== undefined) entry.filled = response.filled;
          if (response.reason !== undefined) entry.reason = response.reason;
          const window = Array.isArray(response.windows) ? response.windows[0] : null;
          if (window) entry.window = { landing: window.landing, authenticated: window.authenticated, foreground: window.foreground, activeTask: window.neisTaskState?.activeTask ?? null };
        }
        if (error) entry.error = { code: error.code, reason: error.reason, message: String(error.message).slice(0, 200) };
        globalThis.__liveNativeCalls.push(entry);
      };
      for (const [kind, klass] of [['edge', NativeOrdinaryEdgeBridge], ['draft', NativeDraftHandoffBridge]]) {
        const original = klass.prototype.run;
        klass.prototype.run = function wrapped(request, operation) {
          const started = Date.now();
          return original.call(this, request, operation).then(
            response => { record(kind, request, response, null, Date.now() - started); return response; },
            error => { record(kind, request, null, error, Date.now() - started); throw error; });
        };
      }
    }, {
      ordinary: path.join(path.dirname(executablePath), 'resources', 'app.asar', 'src', 'ordinary-edge.cjs'),
      draft: path.join(path.dirname(executablePath), 'resources', 'app.asar', 'src', 'draft-handoff.cjs'),
    });

    // With auto-login on, the widget starts a portal operation by itself at launch; a menu
    // pressed on top of it is refused as '이전 작업이 진행 중'. Let that first run finish.
    const startup = { timeline: [], ok: false };
    report.startup = startup;
    {
      const started = Date.now();
      let last = null;
      while (Date.now() - started < perMenuTimeoutMs) {
        const state = await notch.evaluate(() => window.portal.getState());
        const op = state.operation || {};
        const key = `${op.phase}|${op.message}`;
        if (key !== last) { last = key; startup.timeline.push({ t: Date.now() - started, phase: op.phase, message: redact(op.message), busy: op.busy }); }
        if (Date.now() - started > 3000 && !op.busy && !state.authenticationPending) break;
        await pause(250);
      }
      startup.durationMs = Date.now() - started;
      startup.ok = true;
    }

    for (const menu of menus) {
      const timeline = [];
      const started = Date.now();
      let last = null;
      const result = { timeline, ok: false };
      report.menus[menu] = result;
      // `draft+fill` carries a sample draft into the form the product opens — a sample only,
      // clearly marked; nothing is saved or submitted.
      const request = menu === 'draft+fill'
        ? { id: 'draft', draft: { title: '[샘플·상신금지] 위젯 실주행 확인', body: '1. 관련: 업무포털 도우미 실주행 확인\n2. 이 문서는 자동 입력 확인용 샘플이며 상신하지 않습니다.\n3. 줄바꿈이 문단으로 유지되는지 확인합니다.' } }
        : menu;
      const done = notch.evaluate(id => window.portal.openMenu(id), request).catch(error => ({ ok: false, phase: 'harness-error', message: String(error.message) }));
      let settled = null;
      done.then(value => { settled = value; });
      while (settled === null && Date.now() - started < perMenuTimeoutMs) {
        const state = await notch.evaluate(() => window.portal.getState());
        const op = state.operation || {};
        const key = `${op.phase}|${op.message}`;
        if (key !== last) { last = key; timeline.push({ t: Date.now() - started, phase: op.phase, message: redact(op.message), busy: op.busy }); }
        await pause(250);
      }
      result.durationMs = Date.now() - started;
      result.result = settled ? { ok: settled.ok, phase: settled.phase, message: redact(settled.message), reason: settled.reason, drafted: settled.drafted, editorReused: settled.editorReused } : { timedOut: true };
      result.ok = Boolean(settled && settled.ok);
      if (!result.ok) break;
      await pause(1500);
    }
    report.nativeCalls = await app.evaluate(() => globalThis.__liveNativeCalls);
    report.pass = menus.every(menu => report.menus[menu]?.ok);
  } catch (error) {
    report.error = redact(error.stack || error);
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await app.close().catch(() => {});
  }
  process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10));
  process.exitCode = report.pass ? 0 : 1;
})();
