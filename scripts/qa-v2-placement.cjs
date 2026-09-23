'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'qa', 'v2', '04-placement', `attempt-${Date.now()}`);
const profile = path.join(evidence, 'profile');
const settingsPath = path.join(profile, 'settings.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const qaProfiles = new Set([profile]);
const sourceFiles = [
  'src/main.cjs', 'src/preload.cjs', 'src/settings.cjs', 'src/notch-window.cjs', 'src/notch-interaction.cjs', 'src/notch-placement.cjs',
  'renderer/notch.html', 'renderer/notch.css', 'renderer/notch.js', 'renderer/index.html', 'renderer/renderer.js', 'DESIGN.md',
  'tests/core.test.cjs', 'tests/interaction.test.cjs', 'tests/placement.test.cjs', 'scripts/qa-v2-placement.cjs',
];
function sourceHashes() { return Object.fromEntries(sourceFiles.map(file => [file, sha256(path.join(root, file))])); }

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function powershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`PowerShell ${code}: ${stderr}`)));
  });
}

const nativeSource = `Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class Stage4Input {\n[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\n[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);\n[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);\n[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);\n[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint f);\n[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);\n}\n'@\n`;

async function nativeDrag(start, end, options = {}) {
  const steps = options.steps || 6;
  const hold = options.holdMs || 15;
  const release = options.release !== false;
  const lines = ["$ErrorActionPreference='Stop'", nativeSource, `[Stage4Input]::SetCursorPos(${Math.round(start.x)},${Math.round(start.y)})|Out-Null`];
  if (Number.isInteger(options.expectedPid)) lines.push(`$p=New-Object Stage4Input+POINT;$p.X=${Math.round(start.x)};$p.Y=${Math.round(start.y)};$h=[Stage4Input]::GetAncestor([Stage4Input]::WindowFromPoint($p),2);[uint32]$ownerProcessId=0;[Stage4Input]::GetWindowThreadProcessId($h,[ref]$ownerProcessId)|Out-Null;if($ownerProcessId -ne ${options.expectedPid}){throw "Mouse-down owner $ownerProcessId did not match ${options.expectedPid}"}`);
  lines.push('[Stage4Input]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)');
  for (let index = 1; index <= steps; index += 1) {
    const x = Math.round(start.x + (end.x - start.x) * index / steps);
    const y = Math.round(start.y + (end.y - start.y) * index / steps);
    lines.push(`Start-Sleep -Milliseconds ${hold}`, `[Stage4Input]::SetCursorPos(${x},${y})|Out-Null`);
  }
  if (release) lines.push('[Stage4Input]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)');
  return powershell(lines.join('\n'));
}

async function nativeUp() {
  return powershell(`${nativeSource}[Stage4Input]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)`);
}

async function pointOwner(point) {
  const result = await powershell(`$ErrorActionPreference='Stop'\n${nativeSource}$p=New-Object Stage4Input+POINT;$p.X=${Math.round(point.x)};$p.Y=${Math.round(point.y)};$h=[Stage4Input]::GetAncestor([Stage4Input]::WindowFromPoint($p),2);[uint32]$ownerProcessId=0;[Stage4Input]::GetWindowThreadProcessId($h,[ref]$ownerProcessId)|Out-Null;Write-Output "$h|$ownerProcessId"`);
  const [handle, pid] = result.stdout.trim().split('|').map(Number);
  return { handle, pid };
}

async function nativeRect(handle) {
  const result = await powershell(`$ErrorActionPreference='Stop'\nAdd-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class Stage4Rect { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; } [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r); }\n'@\n$r=New-Object Stage4Rect+RECT;if(-not [Stage4Rect]::GetWindowRect([IntPtr]${handle},[ref]$r)){throw 'GetWindowRect failed'};Write-Output "$($r.L)|$($r.T)|$($r.R-$r.L)|$($r.B-$r.T)"`);
  const [x, y, width, height] = result.stdout.trim().split('|').map(Number);
  return { x, y, width, height };
}

async function installedState() {
  const result = await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=37336' -ErrorAction SilentlyContinue;if($p){[pscustomobject]@{pid=$p.ProcessId;path=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress}else{'null'}`);
  return JSON.parse(result.stdout.trim() || 'null');
}

async function screenshot(page, name) {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file, omitBackground: true });
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 100);
  return { file: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(file) };
}

async function launch(factor, targetProfile = profile) {
  const stderr = [];
  const app = await electron.launch({
    args: ['.', `--force-device-scale-factor=${factor}`],
    cwd: root,
    env: { ...process.env, EDUDOCK_QA_PROFILE: targetProfile },
  });
  try {
    app.process().stderr?.on('data', chunk => stderr.push(chunk.toString()));
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    assert.ok(notch.url().endsWith('/notch.html'), `wrong window: ${notch.url()}`);
    await notch.waitForSelector('.placement-handle');
    await notch.waitForFunction(() => document.body.dataset.state === 'expanded');
    let visible = false;
    for (let index = 0; index < 40 && !visible; index += 1) {
      visible = await app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/notch.html'))?.isVisible()));
      if (!visible) await pause(50);
    }
    assert.equal(visible, true, 'notch window is not visible');
    const rendererErrors = [];
    notch.on('pageerror', error => rendererErrors.push(`pageerror:${error.message}`));
    notch.on('console', message => { if (message.type() === 'error') rendererErrors.push(`console:${message.text()}`); });
    return { app, notch, stderr, rendererErrors };
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

async function runtime(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/notch.html'));
    const bounds = window.getBounds();
    return {
      pid: process.pid,
      title: window.getTitle(),
      bounds,
      physicalBounds: screen.dipToScreenRect(window, bounds),
      displays: screen.getAllDisplays().map(display => ({ id: String(display.id), bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor, rotation: display.rotation, internal: display.internal })),
    };
  });
}

async function physical(app, point) {
  return app.evaluate(({ screen }, dip) => screen.dipToScreenPoint(dip), point);
}

async function handlePoint(app, notch, selector) {
  const box = await notch.locator(selector).boundingBox();
  assert.ok(box, `${selector} has no box`);
  const run = await runtime(app);
  const dip = { x: run.bounds.x + box.x + box.width / 2, y: run.bounds.y + box.y + box.height / 2 };
  return { box, dip, physical: await physical(app, dip), runtime: run };
}

async function state(notch) { return notch.evaluate(() => window.portal.getState()); }

async function waitSettled(notch) {
  await notch.waitForFunction(() => document.body.dataset.placing !== 'true');
  await pause(80);
}

async function dragHandle(app, notch, selector, destinationDip, options) {
  const start = await handlePoint(app, notch, selector);
  const owner = await pointOwner(start.physical);
  assert.equal(owner.pid, start.runtime.pid, `native point owner mismatch at ${selector}`);
  const destination = await physical(app, destinationDip);
  await nativeDrag(start.physical, destination, { ...options, expectedPid: start.runtime.pid });
  if (options?.release !== false) await waitSettled(notch);
  return { start, destinationDip, destination, owner };
}

async function clickActionEdge(app, notch, selector, side) {
  const box = await notch.locator(selector).boundingBox();
  assert.ok(box);
  const run = await runtime(app);
  const dip = { x: run.bounds.x + box.x + (side === 'start' ? 2 : box.width - 2), y: run.bounds.y + box.y + box.height / 2 };
  const native = await physical(app, dip);
  const owner = await pointOwner(native);
  assert.equal(owner.pid, run.pid);
  await nativeDrag(native, native, { steps: 1, holdMs: 10, expectedPid: run.pid });
  let auxiliary;
  for (let index = 0; index < 30 && !auxiliary; index += 1) {
    auxiliary = app.windows().find(page => page.url().includes('/index.html'));
    if (!auxiliary) await pause(50);
  }
  assert.ok(auxiliary, `${selector} did not open auxiliary`);
  await auxiliary.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const auxiliaryWindow = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/index.html'));
    auxiliaryWindow?.hide();
    const notchWindow = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/notch.html'));
    notchWindow?.show(); notchWindow?.focus();
  });
  return { selector, side, dip, native, owner, auxiliaryUrl: auxiliary.url() };
}

(async () => {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    schemaVersion: 4,
    alwaysOnTop: true,
    displayMode: 'expanded',
    placement: { edge: 'right', monitorId: null, offsets: { top: 0.5, right: 0.35, bottom: 0.5, left: 0.5 }, scale: 1, lastEdges: { horizontal: 'top', vertical: 'right' } },
    buttons: ['portal', 'neis', 'attendance', 'trip', 'draft', 'compose'],
  }, null, 2));
  const report = { invocation: 'node scripts/qa-v2-placement.cjs', surface: 'Electron 41 + external hidden PowerShell user32 input', scenarios: {}, screenshots: [], processDpi: [], errors: [], cleanup: {} };
  report.sourceHashesStart = sourceHashes();
  let app;
  let completed = false;
  try {
    let launched = await launch(1);
    app = launched.app;
    let notch = launched.notch;
    report.installedBefore = await installedState();
    report.errors.push(...launched.stderr);
    report.displayInventory = (await runtime(app)).displays;
    report.screenshots.push(await screenshot(notch, '01-right-start.png'));

    const beforeQuick = await state(notch);
    const quick = await handlePoint(app, notch, '.move-handle');
    await nativeDrag(quick.physical, quick.physical, { steps: 1, holdMs: 1, expectedPid: quick.runtime.pid });
    await waitSettled(notch);
    const afterQuick = await state(notch);
    assert.equal(afterQuick.settings.placement.edge, beforeQuick.settings.placement.edge);
    assert.equal(afterQuick.interaction.placing, false);

    const moveStart = await handlePoint(app, notch, '.move-handle');
    await notch.evaluate(() => {
      window.__stage4PointerEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'lostpointercapture']) document.addEventListener(type, event => window.__stage4PointerEvents.push({ type, x: event.screenX, y: event.screenY, target: event.target?.className || event.target?.tagName }), true);
    });
    const fastDestinationDip = { x: moveStart.dip.x, y: moveStart.dip.y + 96 };
    const fast = await dragHandle(app, notch, '.move-handle', fastDestinationDip, { steps: 3, holdMs: 15 });
    const afterFast = await state(notch);
    const pointerEvents = await notch.evaluate(() => window.__stage4PointerEvents);
    report.scenarios.fastReleaseObserved = { before: beforeQuick.settings.placement, after: afterFast.settings.placement, input: fast, pointerEvents };
    assert.ok(afterFast.settings.placement.offsets.right > beforeQuick.settings.placement.offsets.right);
    assert.equal(afterFast.interaction.placing, false);

    const cancelStart = await handlePoint(app, notch, '.move-handle');
    const original = JSON.parse(JSON.stringify((await state(notch)).settings.placement));
    const originalBounds = (await runtime(app)).bounds;
    const held = nativeDrag(cancelStart.physical, await physical(app, { x: cancelStart.dip.x, y: cancelStart.dip.y - 80 }), { steps: 4, holdMs: 20, release: false, expectedPid: cancelStart.runtime.pid });
    await held;
    let previewState = await state(notch);
    let previewBounds = (await runtime(app)).bounds;
    for (let index = 0; index < 30 && JSON.stringify(previewBounds) === JSON.stringify(originalBounds); index += 1) {
      await pause(20);
      previewState = await state(notch);
      previewBounds = (await runtime(app)).bounds;
    }
    const persistedDuringPreview = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).placement;
    assert.equal(previewState.interaction.placing, true);
    assert.deepEqual(previewState.settings.placement, original);
    assert.deepEqual(persistedDuringPreview, original);
    assert.notDeepEqual(previewBounds, originalBounds);
    report.screenshots.push(await screenshot(notch, '02-active-snap-preview.png'));
    await notch.keyboard.press('Escape');
    await nativeUp();
    await waitSettled(notch);
    assert.deepEqual((await state(notch)).settings.placement, original);
    const restoredBounds = (await runtime(app)).bounds;
    assert.deepEqual(restoredBounds, originalBounds);
    report.scenarios.gestureSeam = { quickClick: { before: beforeQuick.settings.placement, after: afterQuick.settings.placement }, fastRelease: { input: fast, after: afterFast.settings.placement }, escapeCancel: { originalBounds, previewBounds, placing: previewState.interaction.placing, persistedDuringPreview, restored: original, restoredBounds }, pass: true };

    const keyboardBefore = (await state(notch)).settings.placement;
    await notch.locator('.move-handle').focus();
    assert.equal(await notch.evaluate(() => document.activeElement?.getAttribute('aria-label')), '노치 위치 이동');
    await notch.keyboard.press('ArrowUp');
    const keyboardMoved = (await state(notch)).settings.placement;
    assert.ok(keyboardMoved.offsets.right < keyboardBefore.offsets.right);
    await notch.keyboard.press('ArrowDown');
    await notch.locator('.resize-handle').focus();
    assert.equal(await notch.evaluate(() => document.activeElement?.getAttribute('aria-label')), '노치 크기 조절');
    await notch.keyboard.press('-');
    assert.equal((await state(notch)).settings.placement.scale, 0.95);
    await notch.keyboard.press('+');
    const keyboardRestored = (await state(notch)).settings.placement;
    assert.equal(keyboardRestored.offsets.right, keyboardBefore.offsets.right);
    assert.equal(keyboardRestored.scale, keyboardBefore.scale);
    report.scenarios.keyboardHandles = { moveLabel: '노치 위치 이동', resizeLabel: '노치 크기 조절', before: keyboardBefore, moved: keyboardMoved, restored: keyboardRestored, pass: true };

    for (const edge of ['top', 'left', 'bottom', 'right']) {
      const run = await runtime(app);
      const currentPlacement = (await state(notch)).settings.placement;
      const area = (run.displays.find(display => display.id === currentPlacement.monitorId) || run.displays[0]).workArea;
      const target = edge === 'top' ? { x: area.x + area.width * 0.45, y: area.y + 4 }
        : edge === 'bottom' ? { x: area.x + area.width * 0.55, y: area.y + area.height - 4 }
          : edge === 'left' ? { x: area.x + 4, y: area.y + area.height * 0.4 }
            : { x: area.x + area.width - 4, y: area.y + area.height * 0.6 };
      const input = await dragHandle(app, notch, '.move-handle', target, { steps: 12, holdMs: 12 });
      const placed = await state(notch);
      const bounds = (await runtime(app)).bounds;
      assert.equal(placed.settings.placement.edge, edge);
      const gap = edge === 'top' ? bounds.y - area.y : edge === 'bottom' ? area.y + area.height - (bounds.y + bounds.height) : edge === 'left' ? bounds.x - area.x : area.x + area.width - (bounds.x + bounds.width);
      assert.equal(gap, 0);
      report.screenshots.push(await screenshot(notch, `edge-${edge}.png`));
      report.scenarios[`edge-${edge}`] = { target, input, bounds, workArea: area, gap, pass: true };
    }

    const dualRun = await runtime(app);
    const negativeDisplay = dualRun.displays.find(display => display.workArea.x < 0);
    const primaryDisplay = dualRun.displays.find(display => display.workArea.x === 0);
    assert.ok(negativeDisplay && primaryDisplay, 'real negative-coordinate second display is required for this scenario');
    await dragHandle(app, notch, '.move-handle', { x: negativeDisplay.workArea.x + 4, y: negativeDisplay.workArea.y + negativeDisplay.workArea.height * 0.45 }, { steps: 16, holdMs: 12 });
    const negativeState = await state(notch);
    const negativeBounds = (await runtime(app)).bounds;
    assert.equal(negativeState.settings.placement.monitorId, negativeDisplay.id);
    assert.equal(negativeState.settings.placement.edge, 'left');
    assert.equal(negativeBounds.x, negativeDisplay.workArea.x);
    assert.ok(negativeBounds.x < 0);
    report.screenshots.push(await screenshot(notch, '05-real-negative-monitor.png'));
    report.scenarios.realNegativeMonitor = { display: negativeDisplay, placement: negativeState.settings.placement, bounds: negativeBounds, gap: 0, pass: true };
    await dragHandle(app, notch, '.move-handle', { x: primaryDisplay.workArea.x + primaryDisplay.workArea.width - 4, y: primaryDisplay.workArea.y + primaryDisplay.workArea.height * 0.6 }, { steps: 16, holdMs: 12 });
    assert.equal((await state(notch)).settings.placement.monitorId, primaryDisplay.id);

    let run = await runtime(app);
    let resize = await handlePoint(app, notch, '.resize-handle');
    await dragHandle(app, notch, '.resize-handle', { x: resize.dip.x + 120, y: resize.dip.y }, { steps: 8, holdMs: 10 });
    let resized = await state(notch);
    assert.equal(resized.settings.placement.scale, 0.85);
    const minBounds = (await runtime(app)).bounds;
    const actionLayout = await notch.locator('.actions button').evaluateAll(buttons => ({ viewport: { width: innerWidth, height: innerHeight }, boxes: buttons.map(button => { const box = button.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; }) }));
    assert.ok(actionLayout.boxes.every(box => box.x >= 0 && box.y >= 0 && box.x + box.width <= actionLayout.viewport.width && box.y + box.height <= actionLayout.viewport.height));
    const minActionEdge = await clickActionEdge(app, notch, 'button[data-auxiliary="settings"]', 'start');
    report.screenshots.push(await screenshot(notch, '06-scale-min.png'));

    resize = await handlePoint(app, notch, '.resize-handle');
    await dragHandle(app, notch, '.resize-handle', { x: resize.dip.x - 260, y: resize.dip.y }, { steps: 12, holdMs: 10 });
    resized = await state(notch);
    assert.equal(resized.settings.placement.scale, 1.5);
    const maxRun = await runtime(app);
    const maxBounds = maxRun.bounds;
    const maxPlacement = (await state(notch)).settings.placement;
    const maxArea = (maxRun.displays.find(display => display.id === maxPlacement.monitorId) || maxRun.displays[0]).workArea;
    assert.equal(maxArea.x + maxArea.width - (maxBounds.x + maxBounds.width), 0);
    const maxActionEdge = await clickActionEdge(app, notch, 'button[data-auxiliary="draft"]', 'end');
    report.screenshots.push(await screenshot(notch, '07-scale-max.png'));
    resize = await handlePoint(app, notch, '.resize-handle');
    const reachableEndpoint = { x: maxArea.x + maxArea.width - 1, y: resize.dip.y };
    const maxToMin = await dragHandle(app, notch, '.resize-handle', reachableEndpoint, { steps: 10, holdMs: 10 });
    assert.equal((await state(notch)).settings.placement.scale, 0.85);
    assert.ok(reachableEndpoint.x < maxArea.x + maxArea.width);
    resize = await handlePoint(app, notch, '.resize-handle');
    await dragHandle(app, notch, '.resize-handle', { x: resize.dip.x - 60, y: resize.dip.y }, { steps: 10, holdMs: 10 });
    assert.equal((await state(notch)).settings.placement.scale, 1.5);
    report.scenarios.resize = { min: { scale: 0.85, bounds: minBounds, actions: actionLayout, nativeActionEdge: minActionEdge }, max: { scale: 1.5, bounds: maxBounds, nativeActionEdge: maxActionEdge }, reachableMaxToMin: { input: maxToMin, endpoint: reachableEndpoint, scale: 0.85, restoredMax: true }, pass: true };

    const persistedBeforeRestart = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).placement;
    await app.close(); app = null;
    launched = await launch(1);
    app = launched.app; notch = launched.notch;
    const restored = (await state(notch)).settings.placement;
    assert.deepEqual(restored, persistedBeforeRestart);
    await pause(450);
    report.screenshots.push(await screenshot(notch, '08-restart-restored.png'));
    await notch.locator('button[data-auxiliary="settings"]').click();
    let settingsPage;
    for (let index = 0; index < 30 && !settingsPage; index += 1) {
      settingsPage = app.windows().find(page => page.url().includes('/index.html'));
      if (!settingsPage) await pause(50);
    }
    assert.ok(settingsPage);
    await settingsPage.waitForSelector('#settings-view:not([hidden])');
    await settingsPage.waitForSelector('#placement-scale');
    assert.equal(await settingsPage.locator('[data-placement-edge]').count(), 4);
    await settingsPage.locator('#placement-scale').scrollIntoViewIfNeeded();
    report.screenshots.push(await screenshot(settingsPage, '09-settings-placement-controls.png'));
    report.scenarios.restart = { persisted: persistedBeforeRestart, restored, pass: true };
    report.errors.push(...launched.stderr, ...launched.rendererErrors);
    await app.close(); app = null;

    for (const factor of [1, 1.25, 1.5, 2]) {
      const dpiProfile = path.join(evidence, `profile-dpi-${String(factor).replace('.', '-')}`);
      qaProfiles.add(dpiProfile);
      fs.mkdirSync(dpiProfile, { recursive: true });
      fs.writeFileSync(path.join(dpiProfile, 'settings.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')), displayMode: 'expanded' }, null, 2));
      const dpi = await launch(factor, dpiProfile);
      app = dpi.app; notch = dpi.notch;
      const observed = await runtime(app);
      const beforeDpi = (await state(notch)).settings.placement;
      const selected = observed.displays.find(display => display.id === beforeDpi.monitorId) || observed.displays[0];
      assert.equal(selected.scaleFactor, factor);
      if (factor === 2) {
        const size = await handlePoint(app, notch, '.resize-handle');
        const outward = beforeDpi.edge === 'right' ? { x: size.dip.x + 100, y: size.dip.y } : { x: size.dip.x, y: size.dip.y + 100 };
        await dragHandle(app, notch, '.resize-handle', outward, { steps: 6, holdMs: 10 });
        assert.equal((await state(notch)).settings.placement.scale, 0.85);
      }
      const grip = await handlePoint(app, notch, '.move-handle');
      const moveDip = ['left', 'right'].includes(beforeDpi.edge) ? { x: grip.dip.x, y: grip.dip.y - 40 } : { x: grip.dip.x - 40, y: grip.dip.y };
      await dragHandle(app, notch, '.move-handle', moveDip, { steps: 5, holdMs: 10 });
      await waitSettled(notch);
      const afterDpi = await state(notch);
      assert.equal(afterDpi.interaction.placing, false);
      assert.notEqual(afterDpi.settings.placement.offsets[afterDpi.settings.placement.edge], beforeDpi.offsets[beforeDpi.edge]);
      const afterRun = await runtime(app);
      const afterArea = (afterRun.displays.find(display => display.id === afterDpi.settings.placement.monitorId) || afterRun.displays[0]).workArea;
      const bounds = afterRun.bounds;
      assert.ok(bounds.x >= afterArea.x && bounds.y >= afterArea.y && bounds.x + bounds.width <= afterArea.x + afterArea.width && bounds.y + bounds.height <= afterArea.y + afterArea.height);
      const gap = afterDpi.settings.placement.edge === 'right' ? afterArea.x + afterArea.width - (bounds.x + bounds.width) : afterDpi.settings.placement.edge === 'left' ? bounds.x - afterArea.x : afterDpi.settings.placement.edge === 'top' ? bounds.y - afterArea.y : afterArea.y + afterArea.height - (bounds.y + bounds.height);
      assert.equal(gap, 0);
      const owner = await pointOwner((await handlePoint(app, notch, '.move-handle')).physical);
      const measuredNativeRect = await nativeRect(owner.handle);
      const capture = await screenshot(notch, `dpi-process-${String(factor).replace('.', '-')}.png`);
      report.screenshots.push(capture);
      report.processDpi.push({ requestedProcessFactor: factor, label: 'Chromium process override; not an OS DPI setting change', observedScaleFactor: selected.scaleFactor, observedDisplays: observed.displays, dipBounds: afterRun.bounds, electronConvertedPhysicalBounds: afterRun.physicalBounds, win32MeasuredPhysicalBounds: measuredNativeRect, nativeDrag: { from: grip.physical, toDip: moveDip }, workArea: afterArea, gap, before: beforeDpi, after: afterDpi.settings.placement, pass: true });
      report.errors.push(...dpi.stderr, ...dpi.rendererErrors);
      await app.close(); app = null;
    }

    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(['top', 'right', 'bottom', 'left'].includes(persisted.placement.edge));
    assert.ok(Number.isFinite(persisted.placement.scale));
    const errorText = report.errors.join('');
    assert.doesNotMatch(errorText, /Uncaught Exception|Object has been destroyed|Unable to find Electron app/i);
    report.installedAfter = await installedState();
    assert.deepEqual(report.installedAfter, report.installedBefore);
    report.sourceHashesEnd = sourceHashes();
    assert.deepEqual(report.sourceHashesEnd, report.sourceHashesStart);
    report.cleanup = { profilesRemoved: false, ownedAppClosed: true, installedProcessBefore: report.installedBefore, installedProcessAfter: report.installedAfter, capturedExceptions: report.errors.filter(value => /Uncaught Exception|Object has been destroyed/i.test(value)).length };
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    completed = true;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify(report, null, 2));
    throw error;
  } finally {
    await nativeUp().catch(() => {});
    if (app) await app.close().catch(() => {});
    await pause(700);
    const removed = [];
    const cleanupErrors = [];
    for (const target of qaProfiles) {
      const absolute = path.resolve(target);
      if (!absolute.startsWith(path.resolve(evidence) + path.sep)) continue;
      try {
        if (fs.existsSync(absolute)) await powershell(`$ErrorActionPreference='Stop';$target=[IO.Path]::GetFullPath('${absolute.replaceAll("'", "''")}');if(-not $target.StartsWith('${path.resolve(evidence).replaceAll("'", "''")}\\',[StringComparison]::OrdinalIgnoreCase)){throw 'unsafe cleanup target'};[IO.Directory]::Delete($target,$true)`);
        removed.push(path.relative(root, absolute));
      } catch (error) { cleanupErrors.push({ path: path.relative(root, absolute), message: error.message }); }
    }
    report.cleanup = { ...report.cleanup, profilesRemoved: removed.length === qaProfiles.size, removedProfiles: removed, cleanupErrors, ownedAppClosed: true };
    const artifact = fs.existsSync(path.join(evidence, 'report.json')) ? 'report.json' : 'failure.json';
    if (fs.existsSync(path.join(evidence, artifact))) fs.writeFileSync(path.join(evidence, artifact), JSON.stringify(report, null, 2));
    if (completed && cleanupErrors.length === 0) console.log(JSON.stringify({ pass: true, report: path.relative(root, path.join(evidence, 'report.json')), scenarios: Object.keys(report.scenarios), processDpi: report.processDpi.length, profilesRemoved: true }, null, 2));
    if (cleanupErrors.length) throw new Error(`QA profile cleanup failed: ${JSON.stringify(cleanupErrors)}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
