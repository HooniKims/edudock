'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PortalAutomation, trusted } = require('../src/portal.cjs');

const root = path.resolve(__dirname, '..');
const attemptId = `attempt-${Date.now()}`;
const attemptDir = path.join(root, 'artifacts', 'qa', 'v2', '05-login', 'live', attemptId);
const statePath = path.join(attemptDir, 'state.json');
const reportPath = path.join(attemptDir, 'report.json');
const profile = path.join(process.env.APPDATA, 'edudock', 'EdgeProfile');
const sourceHashes = JSON.parse(process.env.EDUDOCK_QA_SOURCE_HASHES || '[]');
const ordinaryEdgeObservation = JSON.parse(process.env.EDUDOCK_QA_ORDINARY_EDGE || '{}');
const events = [];
let automation;
let readyProofStarted = false;
let passwordErrorMonitor;
let closeResolver;
let state = {
  attemptId,
  phase: 'starting',
  busy: true,
  authWindowReady: false,
  edgeVisible: false,
  edgeForeground: false,
  authenticated: false,
  logoutVisible: false,
  passwordErrorObserved: false,
  passwordValueRead: false,
  profilePreserved: true,
  startedAt: new Date().toISOString(),
};

fs.mkdirSync(attemptDir, { recursive: true });

function persist(patch = {}) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function ownedEdgeWindowProof() {
  const script = String.raw`
$ErrorActionPreference='Stop'
$profile=$env:EDUDOCK_QA_PROFILE
$all=Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"
$root=$all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains("--user-data-dir=$profile") } | Select-Object -First 1
if($null -eq $root){ [pscustomobject]@{found=$false;visible=$false;foreground=$false} | ConvertTo-Json -Compress; exit 0 }
$ids=New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add([int]$root.ProcessId)
do { $added=$false; foreach($p in $all){ if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){ $added=$true } } } while($added)
$window=$null
foreach($id in $ids){ $candidate=Get-Process -Id $id -ErrorAction SilentlyContinue; if($null -ne $candidate -and $candidate.MainWindowHandle -ne 0){ $window=$candidate; break } }
if($null -eq $window){ [pscustomobject]@{found=$true;rootPid=[int]$root.ProcessId;windowPid=$null;visible=$false;foreground=$false} | ConvertTo-Json -Compress; exit 0 }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QaWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
'@
$h=[IntPtr]$window.MainWindowHandle
[void][QaWin32]::ShowWindow($h,9)
[void][QaWin32]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500
$rect=New-Object QaWin32+RECT
[void][QaWin32]::GetWindowRect($h,[ref]$rect)
[pscustomobject]@{found=$true;rootPid=[int]$root.ProcessId;windowPid=[int]$window.Id;visible=[QaWin32]::IsWindowVisible($h);foreground=([QaWin32]::GetForegroundWindow() -eq $h);rect=[pscustomobject]@{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top}} | ConvertTo-Json -Compress
`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, EDUDOCK_QA_PROFILE: profile },
  });
  return JSON.parse(output.trim());
}

async function publicLogoutControl(context) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      if (!trusted(frame.url())) continue;
      for (const role of ['button', 'link']) {
        const controls = frame.getByRole(role, { name: '\uB85C\uADF8\uC544\uC6C3', exact: true });
        for (let index = 0; index < await controls.count(); index += 1) {
          const control = controls.nth(index);
          if (!await control.isVisible()) continue;
          const semantics = await control.evaluate((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            explicitRole: element.getAttribute('role'),
          }));
          return { visible: true, role, ...semantics };
        }
      }
    }
  }
  return { visible: false };
}

function portalOrigin(context) {
  for (const page of context.pages()) {
    try {
      const origin = new URL(page.url()).origin;
      if (origin === 'https://sen.eduptl.kr') return origin;
    } catch {}
  }
  return null;
}

async function observePasswordErrorOnce() {
  if (!automation?.context || state.passwordErrorObserved) return;
  const pattern = /(?:\uC778\uC99D\uC11C\s*)?\uBE44\uBC00\uBC88\uD638.*(?:\uC624\uB958|\uD2C0|\uBD88\uC77C\uCE58|\uC798\uBABB)/;
  for (const page of automation.context.pages()) {
    const matches = page.getByText(pattern);
    for (let index = 0; index < await matches.count(); index += 1) {
      if (!await matches.nth(index).isVisible()) continue;
      persist({ passwordErrorObserved: true, phase: 'password-error', busy: false });
      process.stdout.write('PASSWORD ERROR OBSERVED ONCE; NO RETRY\n');
      automation.cancel();
      return;
    }
  }
}

async function proveVisibleReady() {
  if (readyProofStarted) return;
  readyProofStarted = true;
  try {
    const proof = ownedEdgeWindowProof();
    const ready = proof.found === true && proof.visible === true && proof.foreground === true;
    persist({
      authWindowReady: ready,
      edgeRootPid: proof.rootPid || null,
      edgeWindowPid: proof.windowPid || null,
      edgeVisible: proof.visible === true,
      edgeForeground: proof.foreground === true,
      edgeWindowRect: proof.rect || null,
    });
    process.stdout.write(`WINDOW PROOF ${JSON.stringify(proof)}\n`);
    if (ready) process.stdout.write('EDGE VISIBLE AUTH READY\n');
    else process.stdout.write('EDGE AUTH DOM READY BUT NATIVE WINDOW PROOF FAILED\n');
    passwordErrorMonitor = setInterval(() => { observePasswordErrorOnce().catch(() => {}); }, 500);
  } catch (error) {
    persist({ authWindowReady: false, windowProofError: error.name || 'Error' });
    process.stdout.write('EDGE AUTH DOM READY BUT NATIVE WINDOW PROOF FAILED\n');
  }
}

function status(event) {
  const safe = { at: new Date().toISOString(), phase: event.phase, busy: Boolean(event.busy) };
  events.push(safe);
  persist({ phase: safe.phase, busy: safe.busy });
  process.stdout.write(`PHASE ${safe.phase} busy=${safe.busy}\n`);
  if (safe.phase === 'awaiting-user-auth') setImmediate(() => { proveVisibleReady().catch(() => {}); });
}

async function waitForCleanupCoordination(maxMs = 60000) {
  persist({ awaitingCleanupCoordination: true });
  process.stdout.write('AWAITING CLEANUP COORDINATION; send close on stdin\n');
  await Promise.race([
    new Promise((resolve) => { closeResolver = resolve; }),
    new Promise((resolve) => setTimeout(resolve, maxMs)),
  ]);
  closeResolver = null;
  persist({ awaitingCleanupCoordination: false });
}

async function closeOwnedContext() {
  if (passwordErrorMonitor) clearInterval(passwordErrorMonitor);
  if (automation?.context) await automation.context.close().catch(() => {});
  persist({ contextClosed: true, profilePreserved: true, busy: false });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  if (data.trim().toLowerCase() === 'close' && closeResolver) closeResolver();
});

async function main() {
  persist();
  automation = new PortalAutomation({ profile, status });
  const result = await automation.openMenu('portal');
  if (passwordErrorMonitor) clearInterval(passwordErrorMonitor);
  const origin = automation.context ? portalOrigin(automation.context) : null;
  const logout = automation.context ? await publicLogoutControl(automation.context) : { visible: false };
  const authenticated = result.ok === true && events.some((event) => event.phase === 'authenticated') && logout.visible;
  const outcome = authenticated ? 'authenticated'
    : state.passwordErrorObserved ? 'password-error'
      : result.phase === 'cancelled' ? 'cancelled'
        : result.phase === 'needs-user' ? 'timeout' : 'error';
  persist({
    phase: outcome,
    busy: false,
    portalOrigin: origin,
    logoutVisible: logout.visible,
    logoutSemantics: logout.visible ? logout : null,
    authenticated,
    outcome,
    finishedAt: new Date().toISOString(),
  });
  const report = {
    scenario: "retry actual PortalAutomation.openMenu('portal') with native visible/foreground proof",
    invocation: 'node scripts/qa-v2-live-auth-retry.cjs',
    attemptId,
    sourceHashes,
    ordinaryEdgeObservation,
    profileKind: 'normal app-owned EdgeProfile',
    profilePreserved: true,
    passwordValueRead: false,
    events,
    observable: {
      resultOk: result.ok === true,
      outcome,
      portalOrigin: origin,
      edgeRootPid: state.edgeRootPid || null,
      edgeVisible: state.edgeVisible,
      edgeForeground: state.edgeForeground,
      logoutVisible: logout.visible,
      logoutSemantics: logout.visible ? logout : null,
      authenticated,
    },
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`RESULT ${JSON.stringify(report.observable)}\n`);
  await waitForCleanupCoordination();
  await closeOwnedContext();
}

main().catch(async (error) => {
  persist({ phase: 'driver-error', busy: false, outcome: 'error', errorName: error.name || 'Error' });
  process.stderr.write(`DRIVER ERROR ${error.name || 'Error'}\n`);
  await waitForCleanupCoordination();
  await closeOwnedContext();
  process.exitCode = 1;
});
