'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const menuIndex = process.argv.indexOf('--menu');
const menu = menuIndex >= 0 ? process.argv[menuIndex + 1] : null;
if (!['portal', 'neis'].includes(menu)) throw new Error('Use --menu portal or --menu neis.');
const edgePidIndex = process.argv.indexOf('--edge-pid');
const edgeHwndIndex = process.argv.indexOf('--edge-hwnd');
const expectedEdgePid = Number(edgePidIndex >= 0 ? process.argv[edgePidIndex + 1] : 20996);
const expectedEdgeHwnd = String(edgeHwndIndex >= 0 ? process.argv[edgeHwndIndex + 1] : '98112254');
if (!Number.isInteger(expectedEdgePid) || expectedEdgePid <= 0 || !/^\d+$/.test(expectedEdgeHwnd)) throw new Error('Valid --edge-pid and --edge-hwnd are required.');

const evidenceDir = path.join(root, 'artifacts', 'qa', 'v2', '06-main-menus', menu);
const attempt = path.join(evidenceDir, `attempt-${Date.now()}`);
const profile = path.join(attempt, 'profile');
const reportPath = path.join(attempt, 'report.json');
const relative = value => path.relative(root, value).replaceAll('\\', '/');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function sha256(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex').toUpperCase();
}

async function withDeadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sanitizeHarnessError(error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replace(/https?:\/\/[^\s)]+/gi, '[URL_REDACTED]')
    .replace(/(password|secret|cookie)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .slice(0, 800);
  const stack = error instanceof Error && typeof error.stack === 'string'
    ? error.stack.split(/\r?\n/).slice(0, 8).join('\n')
      .replace(/https?:\/\/[^\s)]+/gi, '[URL_REDACTED]')
      .replace(/(password|secret|cookie)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    : null;
  return { name: error instanceof Error ? error.name : 'UnknownError', message, stack };
}

function edgeWindowState() {
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QaMenuWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}

'@
$h=[IntPtr][Int64]$env:EDUDOCK_QA_EDGE_HWND
[uint32]$owner=0
[void][QaMenuWindow]::GetWindowThreadProcessId($h,[ref]$owner)
[pscustomobject]@{
  pid=[int]$env:EDUDOCK_QA_EDGE_PID
  hwnd=$env:EDUDOCK_QA_EDGE_HWND
  ownerMatches=([int]$owner -eq [int]$env:EDUDOCK_QA_EDGE_PID)
  visible=[QaMenuWindow]::IsWindowVisible($h)
  foreground=([QaMenuWindow]::GetForegroundWindow() -eq $h)
} | ConvertTo-Json -Compress
`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, EDUDOCK_QA_EDGE_PID: String(expectedEdgePid), EDUDOCK_QA_EDGE_HWND: expectedEdgeHwnd },
  });
  return JSON.parse(output.trim());
}

function interactiveDesktopState() {
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QaInteractiveDesktop {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SwitchDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$desktop=[QaInteractiveDesktop]::OpenInputDesktop(0,$false,0x0100)
$switchable=$false
if($desktop -ne [IntPtr]::Zero){$switchable=[QaInteractiveDesktop]::SwitchDesktop($desktop);[void][QaInteractiveDesktop]::CloseDesktop($desktop)}
$logonCount=@(Get-Process -Name LogonUI -ErrorAction SilentlyContinue).Count
[pscustomobject]@{
  inputDesktopOpen=($desktop -ne [IntPtr]::Zero)
  inputDesktopSwitchable=$switchable
  foregroundNonZero=([QaInteractiveDesktop]::GetForegroundWindow() -ne [IntPtr]::Zero)
  logonUIProcessCount=$logonCount
  interactiveReady=(($desktop -ne [IntPtr]::Zero)-and $switchable -and ([QaInteractiveDesktop]::GetForegroundWindow() -ne [IntPtr]::Zero) -and $logonCount -eq 0)
} | ConvertTo-Json -Compress
`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim());
}

async function removeOwnedProfile() {
  const resolvedProfile = path.resolve(profile);
  const resolvedAttempt = path.resolve(attempt);
  assert.ok(resolvedProfile.startsWith(`${resolvedAttempt}${path.sep}`), 'unsafe profile cleanup target');
  for (let retry = 0; retry < 10; retry += 1) {
    try {
      await fs.promises.rm(resolvedProfile, { recursive: true, force: true });
      return !fs.existsSync(resolvedProfile);
    } catch {
      await pause(200);
    }
  }
  return false;
}

async function main() {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    schemaVersion: 4,
    autoLogin: false,
    alwaysOnTop: true,
    displayMode: 'expanded',
    placement: {
      edge: 'right',
      monitorId: null,
      offsets: { top: 0.5, right: 0.25, bottom: 0.5, left: 0.5 },
      scale: 1,
      lastEdges: { horizontal: 'top', vertical: 'right' },
    },
    buttons: ['portal', 'neis', 'attendance', 'trip', 'draft', 'compose'],
  }, null, 2));

  const report = {
    invocation: `node scripts/qa-v2-live-menus.cjs --menu ${menu} --edge-pid ${expectedEdgePid} --edge-hwnd ${expectedEdgeHwnd}`,
    scenario: `real Electron page.click for the ${menu} menu against the existing ordinary Edge session`,
    clickSelector: `.actions button[data-menu="${menu}"]`,
    sourceHashes: {
      'src/main.cjs': sha256('src/main.cjs'),
      'src/portal.cjs': sha256('src/portal.cjs'),
      'src/ordinary-edge.cjs': sha256('src/ordinary-edge.cjs'),
      'src/native/ordinary-edge.ps1': sha256('src/native/ordinary-edge.ps1'),
      'renderer/notch.js': sha256('renderer/notch.js'),
    },
    expectedOrdinaryEdge: { pid: expectedEdgePid, hwnd: expectedEdgeHwnd },
    pass: false,
    observable: {},
    cleanup: {},
  };

  let app;
  let notch;
  let ownedElectronPid = null;
  let scenarioError = null;
  let stage = 'before-launch';
  try {
    stage = 'checking-interactive-desktop-before-launch';
    report.desktopBeforeLaunch = interactiveDesktopState();
    if (!report.desktopBeforeLaunch.interactiveReady) throw new Error('Interactive desktop is unavailable; no menu action was attempted.');
    stage = 'launching-electron';
    app = await withDeadline(electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...process.env, EDUDOCK_QA_PROFILE: profile },
    }), 20000, 'Electron launch');
    stage = 'capturing-owned-pid';
    ownedElectronPid = await app.evaluate(() => process.pid);
    report.ownedElectronPid = ownedElectronPid;
    stage = 'wrapping-shell-open-external';
    await app.evaluate(({ shell }) => {
      globalThis.__liveMenuOriginalOpenExternal = shell.openExternal.bind(shell);
      globalThis.__liveMenuOpenExternalCount = 0;
      shell.openExternal = async (...args) => {
        globalThis.__liveMenuOpenExternalCount += 1;
        return globalThis.__liveMenuOriginalOpenExternal(...args);
      };
    });

    stage = 'waiting-first-window';
    const first = await withDeadline(app.firstWindow(), 10000, 'first window');
    notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    stage = 'waiting-menu-selector';
    await notch.waitForSelector(`.actions button[data-menu="${menu}"]`, { timeout: 10000 });
    stage = 'installing-status-observer';
    await notch.evaluate(() => {
      window.__liveMenuStatuses = [];
      window.portal.onStatus(status => window.__liveMenuStatuses.push({ phase: status.phase, busy: Boolean(status.busy) }));
    });

    stage = 'showing-owned-qa-window';
    report.ownedWindowBeforeClick = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/notch.html'));
      if (!window) return null;
      window.show();
      window.focus();
      return { visible: window.isVisible(), focused: window.isFocused(), bounds: window.getBounds() };
    });
    if (!report.ownedWindowBeforeClick?.visible) throw new Error('Owned QA Electron window could not be shown.');
    await notch.bringToFront();
    stage = 'verifying-menu-surface';
    await notch.waitForFunction(() => document.body.dataset.state === 'expanded', null, { timeout: 5000 });
    await pause(500);
    const menuControl = notch.locator(`.actions button[data-menu="${menu}"]`);
    const preClickSurface = await menuControl.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        visible: bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
        inViewport: bounds.right > 0 && bounds.bottom > 0 && bounds.left < innerWidth && bounds.top < innerHeight,
        fullyInViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        viewport: { width: innerWidth, height: innerHeight },
        opacity: style.opacity,
        state: document.body.dataset.state,
      };
    });
    report.preClickSurface = preClickSurface;
    if (!preClickSurface.visible || !preClickSurface.inViewport || preClickSurface.state !== 'expanded') throw new Error('Portal menu control is not visible in the expanded QA window.');
    stage = 'checking-interactive-desktop-before-click';
    report.desktopBeforeClick = interactiveDesktopState();
    if (!report.desktopBeforeClick.interactiveReady) throw new Error('Interactive desktop became unavailable; no menu action was attempted.');
    stage = 'clicking-menu';
    let clickError = null;
    try {
      await notch.click(`.actions button[data-menu="${menu}"]`, { timeout: 5000 });
    } catch (error) {
      clickError = sanitizeHarnessError(error);
    }
    stage = 'reading-post-click-state';
    const postClickState = await notch.evaluate(() => window.portal.getState());
    if (clickError && !postClickState.operation.busy && postClickState.operation.phase === 'idle') {
      const clickFailure = new Error(clickError.message);
      clickFailure.name = clickError.name;
      throw clickFailure;
    }
    stage = 'waiting-terminal-operation';
    await notch.waitForFunction(async () => {
      const state = await window.portal.getState();
      return !state.operation.busy && ['done', 'opened', 'needs-user', 'error', 'cancelled'].includes(state.operation.phase);
    }, null, { timeout: 25000 });

    stage = 'reading-terminal-state';
    const renderer = await notch.evaluate(async () => ({
      statuses: window.__liveMenuStatuses,
      state: await window.portal.getState(),
      diagnostics: await window.portal.getDiagnostics(),
    }));
    stage = 'reading-shell-count';
    const shellOpenExternalCount = await app.evaluate(() => globalThis.__liveMenuOpenExternalCount);
    stage = 'reading-edge-window';
    const edgeWindow = edgeWindowState();
    const terminalPhase = renderer.state.operation.phase;
    const expectedTerminal = menu === 'portal' ? 'done' : 'opened';
    const pass = terminalPhase === expectedTerminal
      && shellOpenExternalCount === 0
      && edgeWindow.ownerMatches === true
      && edgeWindow.visible === true
      && edgeWindow.foreground === true
      && renderer.state.authenticationPending === false;

    report.observable = {
      resultOk: terminalPhase === expectedTerminal,
      resultPhase: terminalPhase,
      terminalPhase,
      phases: renderer.statuses.map(status => status.phase),
      expectedTerminal,
      shellOpenExternalCount,
      existingSessionReused: shellOpenExternalCount === 0,
      edgeWindow,
      foregroundVerified: edgeWindow.foreground === true,
      authenticationPending: renderer.state.authenticationPending,
      retryAvailable: renderer.diagnostics.retryAvailable,
      falseSuccessRejected: terminalPhase === expectedTerminal || !['done', 'opened'].includes(terminalPhase),
      automaticRetries: 0,
      clickTransportError: clickError,
    };
    report.pass = pass;
    stage = 'scenario-complete';
  } catch (error) {
    scenarioError = error;
    const harnessError = sanitizeHarnessError(error);
    let preCancel = null;
    if (notch) {
      preCancel = await notch.evaluate(async () => ({
        state: await window.portal.getState(),
        statuses: window.__liveMenuStatuses || [],
      })).catch(() => null);
    }
    report.observable = {
      ...report.observable,
      driverStage: stage,
      driverErrorName: harnessError.name,
      driverErrorMessage: harnessError.message,
      driverErrorStack: harnessError.stack,
      driverErrorCode: /timed out/i.test(harnessError.message) ? 'TIMEOUT' : 'DRIVER_ERROR',
      preCancel,
    };
    if (app) {
      const cancelled = await notch?.evaluate(() => window.portal.cancelAuth()).catch(() => null);
      report.observable.cancelOnFailure = cancelled?.ok === true;
    }
  } finally {
    if (app) {
      await app.evaluate(({ shell, app: electronApp }) => {
        if (globalThis.__liveMenuOriginalOpenExternal) shell.openExternal = globalThis.__liveMenuOriginalOpenExternal;
        electronApp.exit(0);
      }).catch(() => {});
    }
    for (let index = 0; index < 20 && ownedElectronPid && processExists(ownedElectronPid); index += 1) await pause(100);
    if (ownedElectronPid && processExists(ownedElectronPid)) {
      try { process.kill(ownedElectronPid); } catch {}
      await pause(300);
    }
    report.cleanup = {
      ownedElectronPid,
      ownedElectronExited: ownedElectronPid ? !processExists(ownedElectronPid) : true,
      ownedProfileRemoved: await removeOwnedProfile(),
      ordinaryEdgeClosed: false,
      installedEduDockClosed: false,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(evidenceDir, 'latest.json'), `${JSON.stringify({ attempt: relative(attempt), report: relative(reportPath) }, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({ pass: report.pass, observable: report.observable, cleanup: report.cleanup, report: relative(reportPath) }, null, 2)}\n`);
  if (!report.pass || scenarioError) process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
