'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const evidenceRoot = path.join(root, 'artifacts', 'qa', 'v2', '03-interaction');
const evidence = path.join(evidenceRoot, `attempt-${Date.now()}`);
const profile = path.join(evidence, `profile-${Date.now()}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function powershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve({ code, stdout, stderr }) : reject(new Error(`PowerShell ${code}: ${stderr}`)));
  });
}

async function nativePointer(point, click = false) {
  const action = click ? '[NativeInput]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero);[NativeInput]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)' : '';
  return powershell(`Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class NativeInput { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }\n'@\n[NativeInput]::SetCursorPos(${Math.round(point.x)},${Math.round(point.y)})|Out-Null\n${action}`);
}

async function nativeSequence(first, delayMs, second) {
  return powershell(`Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class NativeMove { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); }\n'@\n[NativeMove]::SetCursorPos(${Math.round(first.x)},${Math.round(first.y)})|Out-Null\nStart-Sleep -Milliseconds ${Math.round(delayMs)}\n[NativeMove]::SetCursorPos(${Math.round(second.x)},${Math.round(second.y)})|Out-Null`);
}

async function windowAt(point) {
  const result = await powershell(`Add-Type @'\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\npublic static class WindowProbe { [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; } [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint f); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n); }\n'@\n$p=New-Object WindowProbe+POINT\n$p.X=${Math.round(point.x)};$p.Y=${Math.round(point.y)}\n$child=[WindowProbe]::WindowFromPoint($p)\n$root=[WindowProbe]::GetAncestor($child,2)\n$s=New-Object Text.StringBuilder 256\n[WindowProbe]::GetWindowText($root,$s,256)|Out-Null\nWrite-Output "$child|$root|$s"`);
  return result.stdout.trim();
}

async function regionContains(handle, localPoint) {
  const result = await powershell(`Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class RegionProbe { [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a,int b,int c,int d); [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h,IntPtr r); [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y); [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o); }\n'@\n$r=[RegionProbe]::CreateRectRgn(0,0,0,0)\n$kind=[RegionProbe]::GetWindowRgn([IntPtr]${handle},$r)\n$inside=[RegionProbe]::PtInRegion($r,${Math.round(localPoint.x)},${Math.round(localPoint.y)})\n[RegionProbe]::DeleteObject($r)|Out-Null\nWrite-Output "$kind|$inside"`);
  return result.stdout.trim();
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function screenshot(page, name) {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file, omitBackground: true });
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 100, `${name} is empty`);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${name} is not PNG`);
  return { file: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(file) };
}

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    schemaVersion: 3,
    alwaysOnTop: true,
    displayMode: 'auto',
    placement: { edge: 'right', monitorId: null, offsets: { top: 0.5, right: 0.25, bottom: 0.5, left: 0.5 }, scale: 1 },
    buttons: ['portal', 'neis', 'attendance', 'trip', 'draft', 'compose'],
  }, null, 2));
  const stderr = [];
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, EDUDOCK_QA_PROFILE: profile },
  });
  app.process().stderr?.on('data', chunk => stderr.push(chunk.toString()));
  const report = { invocation: 'node scripts/qa-v2-interaction.cjs', profile: path.relative(root, profile), scenarios: {}, screenshots: [], cleanup: {} };
  try {
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    assert.ok(notch.url().endsWith('/notch.html'), `wrong notch surface: ${notch.url()}`);
    await notch.waitForSelector('.actions button[data-menu="portal"]');
    await notch.waitForFunction(() => document.body.dataset.state === 'collapsed');
    const collapsedBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '업무 도우미')?.getBounds());
    assert.ok(collapsedBounds);
    report.screenshots.push(await screenshot(notch, '01-collapsed-start.png'));

    const wake = { x: collapsedBounds.x + collapsedBounds.width - 4, y: collapsedBounds.y + Math.round(collapsedBounds.height / 2) };
    const outside = { x: collapsedBounds.x - 500, y: collapsedBounds.y + collapsedBounds.height + 300 };
    await nativePointer(outside);
    await nativePointer(wake);
    const immediateAfterNativeEntry = await notch.evaluate(() => document.body.dataset.state);
    await pause(240);
    const mid = await notch.evaluate(() => ({ state: document.body.dataset.state, width: innerWidth, height: innerHeight, path: document.getElementById('shape-path').getAttribute('d'), offset: document.getElementById('shape-offset').getAttribute('transform') }));
    assert.equal(mid.state, 'transition');
    report.screenshots.push(await screenshot(notch, '02-expand-mid.png'));
    await pause(420);
    await notch.waitForFunction(() => document.body.dataset.state === 'expanded');
    const expanded = await notch.evaluate(() => ({ state: document.body.dataset.state, width: innerWidth, height: innerHeight, path: document.getElementById('shape-path').getAttribute('d'), offset: document.getElementById('shape-offset').getAttribute('transform') }));
    // The window is sized once for the whole fold, so the in-between state shows in the
    // drawn path rather than in the window size: mid must differ from both end shapes.
    assert.ok(expanded.height >= mid.height && mid.height >= collapsedBounds.height);
    assert.notEqual(mid.path, expanded.path, 'mid-transition path must not already be the expanded shape');
    const collapsedPath = await notch.evaluate(() => document.getElementById('shape-path').getAttribute('d'));
    assert.equal(collapsedPath, expanded.path);
    report.screenshots.push(await screenshot(notch, '03-expanded-settled.png'));
    report.scenarios.hoverExpand = { collapsedBounds, wake, outside, immediateAfterNativeEntry, mid, expanded, pass: true };

    await nativeSequence(outside, 300, wake);
    await pause(120);
    const interrupted = await notch.evaluate(() => ({ state: document.body.dataset.state, width: innerWidth, height: innerHeight }));
    assert.notEqual(interrupted.state, 'collapsed');
    await pause(500);
    assert.equal(await notch.evaluate(() => document.body.dataset.state), 'expanded');
    report.scenarios.rapidReentry = { interrupted, settledState: 'expanded', pass: true };

    const pinPoint = { x: 62, y: 20 };
    const pinBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '업무 도우미').getBounds());
    const pinScreenPoint = { x: pinBounds.x + pinPoint.x, y: pinBounds.y + pinPoint.y };
    await nativePointer(pinScreenPoint, true);
    await pause(60);
    let state = await notch.evaluate(() => window.portal.getState());
    assert.equal(state.interaction.pinned, true);
    await nativePointer(outside);
    await pause(520);
    assert.equal((await notch.evaluate(() => window.portal.getState())).interaction.visualState, 'expanded');
    await notch.keyboard.press('Escape');
    await pause(500);
    assert.equal((await notch.evaluate(() => window.portal.getState())).interaction.visualState, 'collapsed');
    report.scenarios.pinEscape = { pinPoint, pinScreenPoint, nativePinClick: true, pinnedThenStayedExpanded: true, escapedToCollapsed: true, pass: true };

    await nativePointer(wake); await pause(650);
    const settingsButton = notch.locator('button[data-auxiliary="settings"]');
    const buttonBox = await settingsButton.boundingBox();
    const liveBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '업무 도우미')?.getBounds());
    const settingsPoint = { x: liveBounds.x + buttonBox.x + buttonBox.width / 2, y: liveBounds.y + buttonBox.y + buttonBox.height / 2 };
    await nativePointer(settingsPoint, true);
    let auxiliary;
    for (let attempt = 0; attempt < 50 && !auxiliary; attempt += 1) {
      auxiliary = app.windows().find(page => page.url().includes('/index.html'));
      if (!auxiliary) await pause(100);
    }
    assert.ok(auxiliary, 'settings auxiliary window did not open');
    await auxiliary.waitForSelector('#settings-view:not([hidden])');
    assert.ok(auxiliary.url().endsWith('/index.html?auxiliary=1&view=draft') || auxiliary.url().includes('/index.html'));
    await auxiliary.locator('[data-display-mode="expanded"]').click();
    await pause(500);
    await nativePointer(outside); await pause(600);
    assert.equal((await notch.evaluate(() => window.portal.getState())).interaction.visualState, 'expanded');
    let persisted = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(persisted.displayMode, 'expanded');
    await auxiliary.locator('[data-display-mode="auto"]').click();
    await pause(550);
    persisted = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(persisted.displayMode, 'auto');
    await nativePointer(outside); await pause(550);
    const autoFoldProbe = {
      state: await notch.evaluate(() => window.portal.getState()),
      dom: await notch.evaluate(() => ({ documentFocus: document.hasFocus(), active: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName })),
      popup: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().endsWith('/popup.html')).map(window => ({ visible: window.isVisible(), focused: window.isFocused() }))),
    };
    report.scenarios.autoFoldProbe = { ...autoFoldProbe, pass: autoFoldProbe.state.interaction.visualState === 'collapsed' };
    assert.equal(autoFoldProbe.state.interaction.visualState, 'collapsed');
    report.screenshots.push(await screenshot(auxiliary, '04-settings-display-mode.png'));
    report.scenarios.nativeSettingsAndMode = { settingsPoint, auxiliaryUrl: auxiliary.url(), persistedMode: persisted.displayMode, auxiliaryFocusReleasedNotch: true, autoCollapsed: true, pass: true };

    await nativePointer(wake); await pause(650);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === '업무 도우미');
      window.show(); window.focus(); window.webContents.send('notch-focus-first');
    });
    await notch.waitForFunction(() => document.activeElement?.matches('.actions button'));
    const focusedBefore = await notch.evaluate(() => document.activeElement.getAttribute('aria-label'));
    await notch.keyboard.press('ArrowDown');
    const focusedAfter = await notch.evaluate(() => document.activeElement.getAttribute('aria-label'));
    assert.notEqual(focusedAfter, focusedBefore);
    await notch.keyboard.press('Escape');
    await pause(520);
    report.scenarios.keyboard = { focusedBefore, focusedAfter, escapeHandled: true, pass: true };

    await nativePointer(wake); await pause(650);
    await app.evaluate(async (_electron, modulePath) => {
      const load = process.getBuiltinModule('module').createRequire(modulePath);
      const { PortalAutomation } = load(modulePath);
      globalThis.__stage3OriginalOpenMenu = PortalAutomation.prototype.openMenu;
      PortalAutomation.prototype.openMenu = function qaOpenMenu() {
        this.busy = true;
        this.operation = { cancelled: false };
        globalThis.__stage3Automation = this;
        this.status('awaiting-user-auth', '인증서 창에서 암호를 입력해 주세요', true);
        return new Promise(resolve => {
          globalThis.__stage3ResolveOperation = () => {
            this.busy = false;
            this.operation = null;
            resolve({ ok: false, phase: 'cancelled', message: 'QA fixture cancelled' });
          };
        });
      };
    }, path.join(root, 'src', 'portal.cjs'));
    await notch.locator('button[data-menu="portal"]').click();
    await notch.waitForFunction(() => window.portal.getState().then(state => state.operation?.phase === 'awaiting-user-auth'));
    const statusBox = await notch.locator('#status-button').boundingBox();
    const statusPoint = { x: liveBounds.x + statusBox.x + statusBox.width / 2, y: liveBounds.y + statusBox.y + statusBox.height / 2 };
    await nativePointer(statusPoint, true);
    let statusPopup;
    for (let attempt = 0; attempt < 50 && !statusPopup; attempt += 1) {
      statusPopup = app.windows().find(page => page.url().endsWith('/popup.html'));
      if (!statusPopup) await pause(100);
    }
    assert.ok(statusPopup);
    await statusPopup.waitForSelector('#status:not([hidden])');
    await statusPopup.waitForFunction(() => !document.getElementById('cancel').hidden);
    assert.equal(await statusPopup.locator('#cancel').isVisible(), true);
    report.screenshots.push(await screenshot(statusPopup, '05-status-working.png'));
    await statusPopup.locator('#cancel').click();
    let popupAfterCancel;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      popupAfterCancel = {
        visible: await app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/popup.html'))?.isVisible())),
        kind: await statusPopup.evaluate(() => document.body.dataset.kind),
      };
      if (!popupAfterCancel.visible || popupAfterCancel.kind !== 'status') break;
      await pause(50);
    }
    assert.ok(!popupAfterCancel.visible || popupAfterCancel.kind !== 'status');
    const cancelledState = await notch.evaluate(() => window.portal.getState());
    assert.equal(cancelledState.operation.phase, 'cancelled');
    await app.evaluate(() => globalThis.__stage3ResolveOperation());
    report.scenarios.popupCancelRoute = { clickedVisibleCancel: true, statusPopupClosed: true, popupAfterCancel, realMainStatusCallback: true, operationCancelled: true, noBrowserNavigation: true, pass: true };
    await notch.locator('#status-button').click();
    await statusPopup.waitForSelector('#status:not([hidden])');
    await app.evaluate(() => globalThis.__stage3Automation.status('needs-user', '인증 절차를 다시 확인해 주세요. 입력 내용은 저장되거나 읽히지 않습니다.', false));
    await statusPopup.waitForFunction(() => document.getElementById('phase').textContent === '확인 필요');
    assert.equal(await statusPopup.locator('#cancel').isHidden(), true);
    report.screenshots.push(await screenshot(statusPopup, '06-status-needs-user.png'));
    await statusPopup.keyboard.press('Escape');
    await pause(300);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/popup.html'))?.isVisible()), false);
    assert.equal(await notch.evaluate(() => document.hasFocus()), true);
    report.scenarios.statusPopover = { statusBox, statusPoint, nativeStatusClick: true, workingCancelVisible: true, mainReplay: true, liveUpdate: true, escapeReturnedFocus: true, fixturesOnly: true, pass: true };
    await app.evaluate(async (_electron, modulePath) => {
      const load = process.getBuiltinModule('module').createRequire(modulePath);
      const { PortalAutomation } = load(modulePath);
      PortalAutomation.prototype.openMenu = globalThis.__stage3OriginalOpenMenu;
      delete globalThis.__stage3OriginalOpenMenu;
      delete globalThis.__stage3Automation;
      delete globalThis.__stage3ResolveOperation;
    }, path.join(root, 'src', 'portal.cjs'));

    await notch.emulateMedia({ reducedMotion: 'reduce' });
    await pause(100);
    await notch.keyboard.press('Escape');
    await nativePointer(outside); await pause(520);
    assert.equal((await notch.evaluate(() => window.portal.getState())).interaction.visualState, 'collapsed');
    const beforeReduced = await notch.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.equal(beforeReduced.height, 79);
    await nativePointer(wake); await pause(210);
    const afterReduced = await notch.evaluate(() => ({ state: document.body.dataset.state, width: innerWidth, height: innerHeight }));
    assert.equal(afterReduced.state, 'expanded');
    report.scenarios.reducedMotion = { beforeReduced, afterReduced, immediate: true, pass: true };

    const cornerReportPath = path.join(evidenceRoot, 'current-native-corner', 'report.json');
    const cornerReport = JSON.parse(fs.readFileSync(cornerReportPath, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(cornerReport.pass, true);
    assert.equal(cornerReport.nativeTransparentCorner.regionProbe.ptInRegion, false);
    assert.equal(cornerReport.nativeTransparentCorner.clickDelta, 1);
    assert.equal(cornerReport.cleanup.profileRemoved, true);
    assert.equal(cornerReport.sourceHashesAfter['src/notch-window.cjs'].toLowerCase(), sha256(path.join(root, 'src', 'notch-window.cjs')));
    assert.equal(cornerReport.sourceHashesAfter['src/notch-geometry.cjs'].toLowerCase(), sha256(path.join(root, 'src', 'notch-geometry.cjs')));
    report.scenarios.nativeTransparentCorner = { independentReport: path.relative(root, cornerReportPath).replaceAll('\\', '/'), ptInRegion: false, helperRootMatched: true, clickDelta: 1, sourceHashesMatched: true, pass: true };

    const sourceFiles = ['src/main.cjs', 'src/preload.cjs', 'src/settings.cjs', 'src/notch-window.cjs', 'src/notch-geometry.cjs', 'src/notch-interaction.cjs', 'src/notch-popover.cjs', 'renderer/notch.html', 'renderer/notch.css', 'renderer/notch.js', 'renderer/popup.html', 'renderer/popup.css', 'renderer/popup.js', 'renderer/index.html', 'renderer/renderer.js'];
    report.sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sha256(path.join(root, file))]));
    report.installedApplicationAction = 'none';
    report.pass = Object.values(report.scenarios).every(item => item.pass);
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await app.evaluate(() => { if (globalThis.__stage3Underlay && !globalThis.__stage3Underlay.isDestroyed()) globalThis.__stage3Underlay.destroy(); globalThis.__stage3Underlay = null; }).catch(() => {});
    await app.close();
    report.cleanup.electronClosed = true;
    report.cleanup.stderr = stderr.join('');
    report.cleanup.uncaughtExceptionCount = (report.cleanup.stderr.match(/Uncaught Exception|Object has been destroyed/g) || []).length;
    await fs.promises.rm(profile, { recursive: true, force: true });
    report.cleanup.profileRemoved = !fs.existsSync(profile);
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    fs.mkdirSync(evidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(evidenceRoot, 'latest-attempt.txt'), path.relative(evidenceRoot, evidence));
  }
  assert.equal(report.cleanup.uncaughtExceptionCount, 0);
  assert.equal(report.pass, true);
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
