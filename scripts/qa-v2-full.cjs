'use strict';

// Full product QA against the INSTALLED widget, driven the way a teacher drives it: real
// clicks on the notch buttons and the auxiliary window's own form, never internal shortcuts.
// Nothing is saved or submitted; the draft it types is clearly marked as a sample.
//
//   node scripts/qa-v2-full.cjs [--only s3,s5] [--skip s4] [--exe <path>]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const only = option('--only', '').split(',').map(v => v.trim()).filter(Boolean);
const skip = option('--skip', '').split(',').map(v => v.trim()).filter(Boolean);
const executablePath = option('--exe', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'EduDock', 'EduDock.exe'));
const evidence = path.join(root, 'artifacts', 'qa', 'v2', '14-full', `attempt-${Date.now()}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => String(text ?? '').replace(/https?:\/\/[^\s)]+/gi, '[URL]').replace(/__sId=[^&\s]+/gi, '__sId=[R]').slice(0, 400);

const SAMPLE = {
  title: '[샘플·상신금지] 위젯 전체 점검',
  purpose: '업무포털 도우미의 초안 생성과 기안문 입력을 점검합니다.',
  basis: '업무포털 도우미 점검 계획',
  date: '2026-09-25',
  place: '교무실',
  audience: '점검 담당',
};

// Counts Edge tabs without touching them, so a scenario can prove it opened none.
function edgeTabCount() {
  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$total = 0
foreach ($p in @(Get-Process msedge -ErrorAction SilentlyContinue)) {
  if ($p.MainWindowHandle -eq 0) { continue }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  if ($null -eq $root) { continue }
  $c = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $total += @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c) | Where-Object { $_.Current.ClassName -eq 'EdgeTab' }).Count
}
Write-Output $total`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  const value = Number(String(result.stdout).trim());
  return Number.isFinite(value) ? value : null;
}

// The teacher is typing somewhere else. Before each press this puts another window in front,
// so every scenario runs with the widget and Edge behind it, as they would be in real use.
const background = argv.includes('--background');
let standInPid = null;

function powershell(script, timeout = 30000) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout });
  return String(result.stdout || '').trim();
}

const FOREGROUND_HELPERS = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class QaFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static bool Minimise(IntPtr h){ return ShowWindow(h, 6); }
  public static bool IsMin(IntPtr h){ return IsIconic(h); }
  public static string T(IntPtr h){var s=new StringBuilder(200);GetWindowText(h,s,200);return s.ToString();}
  public static bool Raise(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    uint self = GetCurrentThreadId(); uint ignored;
    uint owner = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
    bool a = owner != 0 && owner != self && AttachThreadInput(owner, self, true);
    try { SetForegroundWindow(h); } finally { if (a) AttachThreadInput(owner, self, false); }
    return GetForegroundWindow() == h;
  }
}
'@
function QaFront { $h = [QaFg]::GetForegroundWindow(); $p = 0; [void][QaFg]::GetWindowThreadProcessId($h, [ref]$p); $n = try { (Get-Process -Id $p -EA Stop).ProcessName } catch { '?' }; "$n" }
`;

function frontProcess() {
  return powershell(`${FOREGROUND_HELPERS}\nQaFront`);
}

// A plain window of our own stands in for whatever the teacher is doing. Neither Notepad nor
// cmd works here on Windows 11: Notepad is a Store app whose launcher exits at once, and the
// console is hosted by Windows Terminal, so the cmd process owns no window. Both left nothing
// to raise while the report still printed scenario names, which is worse than no test at all.
const STAND_IN_TITLE = 'EDUDOCK-QA-FOREGROUND';

function startStandIn() {
  if (!background) return null;
  // Through a file, not -Command: the nested quoting of an inline form script came back
  // without a window and the failure looked like the form itself.
  const scriptPath = path.join(evidence, 'stand-in-window.ps1');
  fs.writeFileSync(scriptPath, [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object Windows.Forms.Form',
    `$f.Text = '${STAND_IN_TITLE}'`,
    "$f.Width = 480; $f.Height = 240; $f.StartPosition = 'CenterScreen'",
    '[void]$f.ShowDialog()',
    '',
  ].join('\r\n'), 'utf8');
  const pid = powershell([
    `$w = Start-Process powershell -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${scriptPath}'`,
    'Start-Sleep -Milliseconds 2500',
    '$live = Get-Process -Id $w.Id -EA SilentlyContinue',
    'if ($live -and $live.MainWindowHandle -ne 0) { $live.Id } else { 0 }',
  ].join('; '), 60000);
  standInPid = Number(String(pid).split(/\s+/).filter(Boolean).pop());
  if (!Number.isInteger(standInPid) || standInPid <= 0) throw new Error(`background mode needs a foreground app; the stand-in window did not start (${pid})`);
  return standInPid;
}

// Puts the stand-in window in front and reports what actually ended up there. Which app holds
// the foreground does not matter — a terminal the operator is typing in is just as much
// "somewhere else" as a form. What matters is that it is not the widget and not Edge, because
// the question being asked is whether a press works while the teacher is busy elsewhere.
function ensureBackground() {
  if (!background || !standInPid) return null;
  // Edge is minimised first. Windows will not hand the foreground back to a helper process
  // while Edge holds it, and minimising is also the harshest honest version of the question:
  // the teacher has the browser out of the way and is working in something else entirely.
  // Retried, then reported rather than enforced. Fighting the product for the foreground is a
  // harness problem, not a product verdict: aborting the whole run on it threw away the
  // scenarios that were the point. What each scenario records is what was actually in front
  // when it pressed, so the report can be read for what it is.
  let front = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    front = powershell([
      FOREGROUND_HELPERS,
      'foreach ($e in @(Get-Process msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) { [void][QaFg]::Minimise($e.MainWindowHandle) }',
      `$p = Get-Process -Id ${standInPid} -EA SilentlyContinue`,
      'if ($p) { [void][QaFg]::Raise($p.MainWindowHandle) }',
      'Start-Sleep -Milliseconds 500',
      'QaFront',
    ].join('\n'));
    if (!['msedge', 'WXSClient'].includes(front)) break;
  }
  return front;
}

// Was the browser left minimised, i.e. did the product get its work done without unfolding it?
function edgeMinimised() {
  if (!background) return null;
  return powershell([
    FOREGROUND_HELPERS,
    '$m = @(Get-Process msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and [QaFg]::IsMin($_.MainWindowHandle) }).Count',
    '$t = @(Get-Process msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count',
    'Write-Output "$m/$t"',
  ].join('\n'));
}

function stopStandIn() {
  if (standInPid) powershell(`Stop-Process -Id ${standInPid} -Force -EA SilentlyContinue`);
  standInPid = null;
}

function editorCount() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '@(Get-Process WXSClient -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 30000 });
  const value = Number(String(result.stdout).trim());
  return Number.isFinite(value) ? value : null;
}

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const report = { invocation: 'node scripts/qa-v2-full.cjs', executablePath, startedAt: new Date().toISOString(), scenarios: {}, nativeCalls: [], pass: false };
  const runs = name => (only.length ? only.includes(name) : true) && !skip.includes(name);
  const record = (name, data) => { report.scenarios[name] = data; console.error(`[${name}] ${data.ok ? 'OK' : 'FAIL'} ${data.note || ''}`); };

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.EDUDOCK_QA_PROFILE;
  startStandIn();
  report.background = background;
  const app = await electron.launch({ executablePath, args: [], env });
  try {
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    await notch.waitForFunction(() => Boolean(window.portal));
    const rendererErrors = [];
    notch.on('pageerror', error => rendererErrors.push(`notch: ${error.message}`));

    await app.evaluate(async (_electron, modulePaths) => {
      const load = process.getBuiltinModule('module').createRequire(modulePaths.ordinary);
      const { NativeOrdinaryEdgeBridge } = load(modulePaths.ordinary);
      const { NativeDraftHandoffBridge } = load(modulePaths.draft);
      globalThis.__qaCalls = [];
      const note = (kind, request, response, error, ms) => {
        const entry = { kind, ms, command: request?.command, action: request?.action, system: request?.system };
        if (response) {
          entry.status = response.status;
          for (const key of ['invoked', 'focused', 'filled', 'reason', 'method']) if (response[key] !== undefined) entry[key] = response[key];
          if (response.entry) entry.formEntry = response.entry;
          const window = Array.isArray(response.windows) ? response.windows[0] : null;
          if (window) entry.window = { landing: window.landing, authenticated: window.authenticated, foreground: window.foreground, notice: window.sessionNotice ?? null, activeTask: window.neisTaskState?.activeTask ?? null };
        }
        if (error) entry.error = { code: error.code, reason: error.reason, message: String(error.message).slice(0, 160) };
        globalThis.__qaCalls.push(entry);
      };
      for (const [kind, klass] of [['edge', NativeOrdinaryEdgeBridge], ['draft', NativeDraftHandoffBridge]]) {
        const original = klass.prototype.run;
        klass.prototype.run = function wrapped(request, operation) {
          const started = Date.now();
          return original.call(this, request, operation).then(
            response => { note(kind, request, response, null, Date.now() - started); return response; },
            error => { note(kind, request, null, error, Date.now() - started); throw error; });
        };
      }
    }, {
      ordinary: path.join(path.dirname(executablePath), 'resources', 'app.asar', 'src', 'ordinary-edge.cjs'),
      draft: path.join(path.dirname(executablePath), 'resources', 'app.asar', 'src', 'draft-handoff.cjs'),
    });

    const state = () => notch.evaluate(() => window.portal.getState());
    const idle = async (budgetMs = 180000) => {
      const started = Date.now();
      const seen = [];
      let last = null;
      while (Date.now() - started < budgetMs) {
        const current = await state();
        const operation = current.operation || {};
        const key = `${operation.phase}|${operation.message}`;
        if (key !== last) { last = key; seen.push({ t: Date.now() - started, phase: operation.phase, message: redact(operation.message) }); }
        if (Date.now() - started > 2500 && !operation.busy && !current.authenticationPending) return { timeline: seen, ms: Date.now() - started, settled: true };
        await pause(250);
      }
      return { timeline: seen, ms: Date.now() - started, settled: false };
    };
    const expand = async () => {
      await notch.evaluate(() => window.portal.notchInteraction({ type: 'expand' }));
      await notch.waitForFunction(() => document.body.dataset.state === 'expanded', undefined, { timeout: 5000 });
    };
    // A real click on the notch button, exactly what a hovering teacher does. In background
    // mode another window is put in front first, so the press happens while the teacher is
    // busy elsewhere; the front window is recorded before and after.
    let lastFront = null;
    const pressNotch = async selector => {
      const before = ensureBackground();
      await expand();
      await notch.locator(selector).click({ timeout: 5000 });
      lastFront = { before, afterClick: background ? frontProcess() : null };
    };
    const auxiliary = async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const page = app.windows().find(candidate => candidate.url().includes('/index.html'));
        if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
        await pause(100);
      }
      throw new Error('auxiliary window did not open');
    };

    // ---- S1: launch and auto-login -------------------------------------------------
    const startupFrontBefore = background ? ensureBackground() : null;
    const startup = await idle();
    record('s1-startup', {
      ok: startup.settled && startup.timeline.some(step => ['done', 'authenticated'].includes(step.phase)),
      ms: startup.ms, timeline: startup.timeline,
      foreground: background ? { before: startupFrontBefore, after: frontProcess() } : null,
      note: `${startup.ms}ms, last=${startup.timeline.at(-1)?.phase}${background ? `, 앞창 ${startupFrontBefore}→${frontProcess()}` : ''}`,
    });

    // ---- S2: notch fold ------------------------------------------------------------
    if (runs('s2')) {
      const samples = [];
      for (let round = 0; round < 2; round += 1) {
        await notch.evaluate(() => { window.__f = []; window.__s = true; const t = n => { if (!window.__s) return; window.__f.push(n); requestAnimationFrame(t); }; requestAnimationFrame(t); });
        await notch.evaluate(() => window.portal.notchInteraction({ type: 'expand' }));
        await notch.waitForFunction(() => document.body.dataset.state === 'expanded', undefined, { timeout: 5000 });
        await pause(120);
        await notch.evaluate(() => window.portal.notchInteraction({ type: 'escape' }));
        await notch.waitForFunction(() => document.body.dataset.state === 'collapsed', undefined, { timeout: 5000 });
        const frames = await notch.evaluate(() => { window.__s = false; return window.__f; });
        const gaps = frames.slice(1).map((value, index) => value - frames[index]);
        samples.push({ frames: frames.length, worstGapMs: Number(Math.max(...gaps, 0).toFixed(1)), dropped: gaps.filter(gap => gap > 34).length });
        await pause(400);
      }
      const worst = Math.max(...samples.map(sample => sample.worstGapMs));
      record('s2-fold', { ok: worst <= 40, samples, note: `worst gap ${worst}ms` });
    }

    // ---- S3: 초안 만들기 (compose in the auxiliary window) ---------------------------
    let composed = null;
    if (runs('s3')) {
      const tabsBefore = edgeTabCount();
      await pressNotch('button[data-auxiliary="draft"]');
      const aux = await auxiliary();
      aux.on('pageerror', error => rendererErrors.push(`aux: ${error.message}`));
      await aux.waitForSelector('#draft-view:not([hidden])', { timeout: 15000 });
      await aux.locator('[name=title]').fill(SAMPLE.title);
      await aux.locator('[name=purpose]').fill(SAMPLE.purpose);
      await aux.locator('[name=basis]').fill(SAMPLE.basis);
      await aux.locator('[name=date]').fill(SAMPLE.date);
      await aux.locator('[name=place]').fill(SAMPLE.place);
      await aux.locator('[name=audience]').fill(SAMPLE.audience);
      await aux.locator('#generate-button').click();
      await aux.locator('#draft-output').waitFor({ state: 'visible', timeout: 15000 });
      const body = await aux.locator('#result-body').inputValue();
      const title = await aux.locator('#result-title').inputValue();
      await aux.locator('#copy-draft').click();
      await pause(300);
      const clipboard = await app.evaluate(({ clipboard: board }) => board.readText());
      const fillVisible = await aux.locator('#fill-draft').isVisible();
      composed = { title, body };
      record('s3-compose', {
        ok: body.length > 40 && clipboard.includes(SAMPLE.title) && fillVisible,
        titleLength: title.length, bodyLength: body.length, paragraphs: body.split(/\r?\n/).filter(Boolean).length,
        clipboardMatches: clipboard.includes(SAMPLE.title), fillButtonVisible: fillVisible,
        tabsBefore, tabsAfter: edgeTabCount(),
        note: `body ${body.length}자, 복사 ${clipboard.includes(SAMPLE.title)}`,
      });
    }

    // ---- S4: 기안문에 넣기 (the real button in the draft view) ------------------------
    if (runs('s4') && composed) {
      const editorsBefore = editorCount();
      const aux = await auxiliary();
      const fillFrontBefore = ensureBackground();
      await aux.locator('#fill-draft').click();
      const settled = await idle(240000);
      const after = await state();
      const editorsAfter = editorCount();
      const ok = after.operation?.phase === 'done' && editorsAfter === editorsBefore + 1;
      record('s4-fill', {
        ok, phase: after.operation?.phase, message: redact(after.operation?.message),
        editorsBefore, editorsAfter, ms: settled.ms, timeline: settled.timeline,
        foreground: background ? { before: fillFrontBefore, after: frontProcess() } : null,
        note: `${after.operation?.phase}, 기안창 ${editorsBefore}→${editorsAfter}`,
      });
    }

    // ---- S5: work menus ------------------------------------------------------------
    if (runs('s5')) {
      const menus = option('--menus', 'neis,attendance,trip,edufine,draft').split(',').map(value => value.trim()).filter(Boolean);
      for (const menu of menus) {
        const tabsBefore = edgeTabCount();
        const editorsBefore = editorCount();
        await pressNotch(`button[data-menu="${menu}"]`);
        const settled = await idle(240000);
        const after = await state();
        const tabsAfter = edgeTabCount();
        record(`s5-${menu}`, {
          ok: after.operation?.phase === 'done',
          phase: after.operation?.phase, message: redact(after.operation?.message),
          ms: settled.ms, tabsBefore, tabsAfter, editorsBefore, editorsAfter: editorCount(),
          timeline: settled.timeline,
          foreground: background ? { ...lastFront, afterWork: frontProcess(), edgeMinimised: edgeMinimised() } : null,
          note: `${after.operation?.phase} ${settled.ms}ms, 탭 ${tabsBefore}→${tabsAfter}${background ? `, 앞창 ${lastFront?.before}→${frontProcess()}` : ''}`,
        });
        await pause(1500);
      }
    }

    // ---- S6: settings --------------------------------------------------------------
    if (runs('s6')) {
      await pressNotch('button[data-auxiliary="settings"]');
      const aux = await auxiliary();
      await aux.waitForSelector('#settings-view:not([hidden])', { timeout: 15000 });
      const before = await state();
      await aux.locator('[data-display-mode="expanded"]').click();
      await pause(600);
      const expanded = await state();
      await aux.locator('[data-display-mode="auto"]').click();
      await pause(600);
      await aux.locator('#opacity').fill('70');
      await aux.locator('#opacity').dispatchEvent('input');
      await aux.locator('#opacity').dispatchEvent('change');
      await pause(500);
      const dimmed = await state();
      await aux.locator('#opacity').fill('100');
      await aux.locator('#opacity').dispatchEvent('change');
      await pause(400);
      const edgeBefore = (await state()).settings.placement.edge;
      // The monitor map replaced the old "next edge" button: press an edge that is not current.
      await aux.locator(`#monitor-map .map-screen[data-current="true"] .map-edge[aria-pressed="false"]`).first().click();
      await pause(700);
      const edgeAfter = (await state()).settings.placement.edge;
      await aux.locator('#diagnostics-button').click();
      await pause(800);
      const diagnostics = await aux.locator('#diagnostics-output').textContent();
      record('s6-settings', {
        ok: expanded.settings.displayMode === 'expanded' && dimmed.settings.opacity < 1 && edgeAfter !== edgeBefore && Boolean(diagnostics),
        displayMode: expanded.settings.displayMode, opacity: dimmed.settings.opacity,
        edgeBefore, edgeAfter, diagnosticsLength: (diagnostics || '').length,
        restored: (await state()).settings.opacity,
        note: `mode ${expanded.settings.displayMode}, opacity ${dimmed.settings.opacity}, edge ${edgeBefore}→${edgeAfter}`,
      });
    }

    // ---- S7: hygiene ---------------------------------------------------------------
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), visible: window.isVisible(), url: window.webContents.getURL().split('/').pop() })));
    report.nativeCalls = await app.evaluate(() => globalThis.__qaCalls);
    const failures = report.nativeCalls.filter(call => call.error || (call.status && !['ok', 'unavailable'].includes(call.status)));
    record('s7-hygiene', {
      ok: rendererErrors.length === 0,
      rendererErrors, windows,
      nativeCalls: report.nativeCalls.length,
      nativeFailures: failures.map(call => ({ kind: call.kind, command: call.command, action: call.action, status: call.status, reason: call.reason, error: call.error })),
      note: `renderer errors ${rendererErrors.length}, native failures ${failures.length}`,
    });

    report.pass = Object.values(report.scenarios).every(scenario => scenario.ok);
  } catch (error) {
    report.error = redact(error.stack || error);
    // Collected here too: a run that stops early is exactly when the helper trace is wanted,
    // and leaving it to the last scenario meant the failing run reported none at all.
    try { report.nativeCalls = await app.evaluate(() => globalThis.__qaCalls || []); } catch {}
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await app.close().catch(() => {});
    stopStandIn();
  }
  process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10));
  process.exitCode = report.pass ? 0 : 1;
})();
