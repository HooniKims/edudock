const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const evidenceRoot = path.join(root, 'artifacts', 'qa', 'v2', '02-shape');
let evidence = process.env.EDUDOCK_STAGE2_ATTEMPT_DIR || evidenceRoot;

function ensureEvidence() {
  fs.mkdirSync(evidence, { recursive: true });
}

function pngInfo(file) {
  const bytes = fs.readFileSync(file);
  return {
    file: path.relative(root, file).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    pngSignature: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  };
}

async function integration() {
  const { _electron: electron } = require('playwright-core');
  const profile = path.join(evidence, 'integration-profile');
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, EDUDOCK_QA_PROFILE: profile },
  });
  const stderr = [];
  const appProcess = electronApp.process();
  appProcess.stderr?.on('data', chunk => stderr.push(chunk.toString()));
  const cleanup = { electronClosed: false };
  try {
    const notch = await electronApp.firstWindow();
    await notch.waitForSelector('button[data-auxiliary="draft"]');
    await notch.screenshot({ path: path.join(evidence, 'renderer-top.png'), omitBackground: true });

    const auxiliaryPromise = electronApp.waitForEvent('window');
    await notch.locator('button[data-auxiliary="draft"]').click();
    const auxiliary = await auxiliaryPromise;
    await auxiliary.waitForSelector('#draft-view:not([hidden])');
    const draftText = '설정 방문 후에도 남는 초안';
    await auxiliary.locator('input[name="title"]').fill(draftText);

    await notch.locator('button[data-auxiliary="settings"]').click();
    await auxiliary.waitForSelector('#settings-view:not([hidden])');
    await notch.locator('button[data-auxiliary="draft"]').click();
    await auxiliary.waitForSelector('#draft-view:not([hidden])');
    const preserved = await auxiliary.locator('input[name="title"]').inputValue();
    const windowCount = electronApp.windows().length;
    await auxiliary.screenshot({ path: path.join(evidence, 'aux-draft-preserved.png') });
    for (let index = 0; index < 3; index += 1) {
      await auxiliary.evaluate(() => window.portal.window('close'));
      await notch.locator('button[data-auxiliary="draft"]').click();
      await auxiliary.waitForSelector('#draft-view:not([hidden])');
    }

    const result = {
      invocation: 'node scripts/qa-v2-shape.cjs',
      auxiliaryWindowCount: windowCount - 1,
      draftTextPreserved: preserved === draftText,
      observedValue: preserved,
      notchBounds: await notch.evaluate(() => ({ width: innerWidth, height: innerHeight, edge: document.body.dataset.edge })),
      pass: windowCount === 2 && preserved === draftText,
    };
    fs.writeFileSync(path.join(evidence, 'aux-window.json'), JSON.stringify(result, null, 2));
    if (!result.pass) throw new Error('Auxiliary window reuse or draft preservation failed.');
  } finally {
    await electronApp.close();
    cleanup.electronClosed = true;
    cleanup.stderr = stderr.join('');
    cleanup.uncaughtExceptionCount = (cleanup.stderr.match(/Uncaught Exception|Object has been destroyed/g) || []).length;
    fs.writeFileSync(path.join(evidence, 'integration-cleanup.json'), JSON.stringify(cleanup, null, 2));
    if (cleanup.uncaughtExceptionCount) throw new Error('Lifecycle cleanup emitted an uncaught exception.');
  }
}

async function nativeFixture() {
  const { app, BrowserWindow, screen, desktopCapturer, ipcMain } = require('electron');
  const { createNotchWindow } = require('../src/notch-window.cjs');
  ensureEvidence();
  await app.whenReady();
  let buttonInvocations = 0;
  ipcMain.handle('state', () => ({ settings: baseSettings, authenticationPending: false, version: 'qa' }));
  ipcMain.handle('open-menu', () => {
    buttonInvocations += 1;
    return { ok: true, phase: 'idle', message: 'qa' };
  });

  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const target = new BrowserWindow({
    ...area,
    frame: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#f4f4f0',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;font:600 28px sans-serif}body{display:grid;place-items:center;background:#f4f4f0;color:#111}body.dark{background:#202124;color:#fff}#click{position:absolute;border:0;background:#76acff;color:#000}</style><body><span>EduDock Stage 2 desktop fixture</span><button id="click">UNDERLYING TARGET</button><script>window.__clicks=0;click.onclick=()=>window.__clicks++;</script></body>'));
  target.show();
  target.focus();
  target.setAlwaysOnTop(true, 'floating');

  const baseSettings = {
    alwaysOnTop: true,
    placement: {
      edge: 'top',
      monitorId: String(display.id),
      offsets: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
      scale: 1,
    },
  };
  const controller = createNotchWindow({
    BrowserWindow,
    screen,
    settings: baseSettings,
    preload: path.join(root, 'src', 'preload.cjs'),
    onWindow: () => {},
  });

  await new Promise(resolve => controller.window.webContents.once('did-finish-load', resolve));
  controller.window.showInactive();
  const observations = [];

  async function capture(edge, theme) {
    const settings = { ...baseSettings, placement: { ...baseSettings.placement, edge } };
    const applied = controller.apply(settings);
    await target.webContents.executeJavaScript(`document.body.className='${theme === 'dark' ? 'dark' : ''}'`);
    await new Promise(resolve => setTimeout(resolve, 180));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      },
    });
    const source = sources.find(item => item.display_id === String(display.id)) || sources[0];
    const scale = display.scaleFactor;
    const bounds = applied.bounds;
    const margin = 28;
    const left = Math.max(display.bounds.x, bounds.x - margin);
    const top = Math.max(display.bounds.y, bounds.y - margin);
    const right = Math.min(display.bounds.x + display.bounds.width, bounds.x + bounds.width + margin);
    const bottom = Math.min(display.bounds.y + display.bounds.height, bounds.y + bounds.height + margin);
    const crop = {
      x: Math.round((left - display.bounds.x) * scale),
      y: Math.round((top - display.bounds.y) * scale),
      width: Math.round((right - left) * scale),
      height: Math.round((bottom - top) * scale),
    };
    const file = path.join(evidence, `${edge}-${theme}.png`);
    let cropped = source.thumbnail.crop(crop);
    let png = cropped.toPNG();
    if (png.length < 1000) {
      controller.window.showInactive();
      await new Promise(resolve => setTimeout(resolve, 500));
      const retrySources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor),
        },
      });
      const retry = retrySources.find(item => item.display_id === String(display.id)) || retrySources[0];
      cropped = retry.thumbnail.crop(crop);
      png = cropped.toPNG();
    }
    fs.writeFileSync(file, png);
    const gap = edge === 'top' ? bounds.y - area.y
      : edge === 'bottom' ? area.y + area.height - (bounds.y + bounds.height)
        : edge === 'left' ? bounds.x - area.x
          : area.x + area.width - (bounds.x + bounds.width);
    const bitmap = cropped.toBitmap();
    let nearBlackPixels = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      if (bitmap[index] < 32 && bitmap[index + 1] < 32 && bitmap[index + 2] < 32) nearBlackPixels += 1;
    }
    observations.push({ edge, theme, bounds, workArea: area, gapDip: gap, shapeRects: applied.shape.rects.length, image: { ...pngInfo(file), nearBlackPixels } });
  }

  for (const edge of ['top', 'right', 'bottom', 'left']) {
    await capture(edge, 'light');
    await capture(edge, 'dark');
  }

  const applied = controller.apply(baseSettings);
  const localX = applied.bounds.x - area.x;
  const localY = applied.bounds.y - area.y;
  await target.webContents.executeJavaScript(`Object.assign(document.getElementById('click').style,{left:'${localX}px',top:'${localY}px',width:'28px',height:'56px'});window.__clicks=0`);
  const clickPoint = { x: applied.bounds.x + 1, y: applied.bounds.y + applied.bounds.height - 1 };
  const makeClickScript = (point, delay = 0) => `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[NativeClick]::SetCursorPos(${point.x}, ${point.y}) | Out-Null
${delay ? `Start-Sleep -Milliseconds ${delay}` : ''}
[NativeClick]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
[NativeClick]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
`;
  const makeMoveScript = point => makeClickScript(point).replace(/\[NativeClick\]::mouse_event[^\n]+\n/g, '');
  controller.window.hide();
  target.show();
  target.focus();
  await target.webContents.executeJavaScript('window.__clicks=0');
  await new Promise(resolve => setTimeout(resolve, 120));
  const controlProcess = spawnSync('powershell.exe', ['-NoProfile', '-Command', makeClickScript(clickPoint)], { encoding: 'utf8' });
  await new Promise(resolve => setTimeout(resolve, 250));
  const controlClicks = await target.webContents.executeJavaScript('window.__clicks');
  await target.webContents.executeJavaScript('window.__clicks=0');
  controller.window.showInactive();
  const visiblePoint = { x: applied.bounds.x + Math.round(applied.bounds.width / 2), y: applied.bounds.y + Math.round(applied.bounds.height / 2) };
  const dwellResults = [];
  for (const dwellMs of [0, 20, 40, 80, 120]) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', makeMoveScript(visiblePoint)], { encoding: 'utf8' });
    await new Promise(resolve => setTimeout(resolve, 100));
    await target.webContents.executeJavaScript('window.__clicks=0');
    const clickProcess = spawnSync('powershell.exe', ['-NoProfile', '-Command', makeClickScript(clickPoint, dwellMs)], { encoding: 'utf8' });
    await new Promise(resolve => setTimeout(resolve, 180));
    const underlyingClicks = await target.webContents.executeJavaScript('window.__clicks');
    dwellResults.push({ dwellMs, exitCode: clickProcess.status, underlyingClicks });
  }
  const handle = controller.window.getNativeWindowHandle().readBigUInt64LE().toString();
  const regionScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeRegion {
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a,int b,int c,int d);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h,IntPtr r);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
}
'@
$r=[NativeRegion]::CreateRectRgn(0,0,0,0)
$kind=[NativeRegion]::GetWindowRgn([IntPtr]${handle},$r)
$inside=[NativeRegion]::PtInRegion($r,1,${applied.bounds.height - 1})
[NativeRegion]::DeleteObject($r)|Out-Null
Write-Output "$kind,$inside"
`;
  const region = spawnSync('powershell.exe', ['-NoProfile', '-Command', regionScript], { encoding: 'utf8' });
  const localRectContainsPoint = applied.shape.rects.some(rect => 1 >= rect.x && 1 < rect.x + rect.width && applied.bounds.height - 1 >= rect.y && applied.bounds.height - 1 < rect.y + rect.height);
  const clickthrough = {
    pointDip: clickPoint,
    underlyingElement: await target.webContents.executeJavaScript(`document.elementFromPoint(${clickPoint.x - area.x},${clickPoint.y - area.y})?.id || ''`),
    controlClicks,
    controlExitCode: controlProcess.status,
    underlyingClicks: dwellResults[0].underlyingClicks,
    powershellExitCode: dwellResults[0].exitCode,
    dwellResults,
    localRectContainsPoint,
    nativeRegionProbe: region.stdout.trim(),
    nativeRegionProbeExitCode: region.status,
    rapidMoveAndClick: true,
    pass: controlProcess.status === 0 && controlClicks === 1 && dwellResults.every(result => result.exitCode === 0 && result.underlyingClicks === 1) && !localRectContainsPoint && /False$/i.test(region.stdout.trim()),
  };
  const buttonPoint = { x: applied.bounds.x + applied.shape.curl + 20, y: applied.bounds.y + 28 };
  const outsidePoint = { x: applied.bounds.x - 80, y: applied.bounds.y + 28 };
  const buttonDwellResults = [];
  for (const dwellMs of [0, 20, 40, 80, 120]) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', makeMoveScript(outsidePoint)], { encoding: 'utf8' });
    await new Promise(resolve => setTimeout(resolve, 100));
    buttonInvocations = 0;
    const buttonProcess = spawnSync('powershell.exe', ['-NoProfile', '-Command', makeClickScript(buttonPoint, dwellMs)], { encoding: 'utf8' });
    await new Promise(resolve => setTimeout(resolve, 180));
    buttonDwellResults.push({ dwellMs, exitCode: buttonProcess.status, buttonInvocations });
  }

  const capturesValid = observations.every(item => item.gapDip === 0 && item.image.pngSignature && item.image.bytes > 1000 && item.image.nearBlackPixels > 100);
  const themesDistinct = ['top', 'right', 'bottom', 'left'].every(edge => observations.find(item => item.edge === edge && item.theme === 'light').image.sha256 !== observations.find(item => item.edge === edge && item.theme === 'dark').image.sha256);
  fs.writeFileSync(path.join(evidence, 'edge-matrix.json'), JSON.stringify({ display: { id: display.id, scaleFactor: display.scaleFactor }, observations, capturesValid, themesDistinct, pass: capturesValid && themesDistinct }, null, 2));
  fs.writeFileSync(path.join(evidence, 'click-through.json'), JSON.stringify(clickthrough, null, 2));
  fs.writeFileSync(path.join(evidence, 'click-through-dwell.json'), JSON.stringify({ pointDip: clickPoint, visiblePointDip: visiblePoint, controlClicks, dwellResults, localRectContainsPoint, nativeRegionProbe: region.stdout.trim(), pass: clickthrough.pass }, null, 2));
  fs.writeFileSync(path.join(evidence, 'button-hit-dwell.json'), JSON.stringify({ buttonPointDip: buttonPoint, outsidePointDip: outsidePoint, dwellResults: buttonDwellResults, pass: buttonDwellResults.every(result => result.exitCode === 0 && result.buttonInvocations === 1) }, null, 2));

  controller.destroy();
  target.destroy();
  fs.writeFileSync(path.join(evidence, 'native-cleanup.json'), JSON.stringify({ notchDestroyed: controller.window.isDestroyed(), targetDestroyed: target.isDestroyed() }, null, 2));
  app.quit();
  if (!clickthrough.pass) process.exitCode = 1;
}

async function main() {
  if (!process.versions.electron && !process.env.EDUDOCK_STAGE2_ATTEMPT_DIR) {
    evidence = path.join(evidenceRoot, 'attempts', String(Date.now()));
  }
  ensureEvidence();
  if (process.versions.electron) {
    await nativeFixture();
    return;
  }
  await integration();
  if (process.argv.includes('--integration-only')) {
    console.log(JSON.stringify({ pass: true, lifecycle: 'clean' }, null, 2));
    return;
  }
  const electronBinary = require('electron');
  const native = spawnSync(electronBinary, [__filename, '--native-fixture'], { cwd: root, env: { ...process.env, EDUDOCK_STAGE2_ATTEMPT_DIR: evidence }, encoding: 'utf8', timeout: 90000 });
  fs.writeFileSync(path.join(evidence, 'native-process.txt'), `exit=${native.status}\nstdout:\n${native.stdout}\nstderr:\n${native.stderr}`);
  if (native.status !== 0) throw new Error(`Native fixture failed with exit ${native.status}: ${native.stderr}`);
  const matrix = JSON.parse(fs.readFileSync(path.join(evidence, 'edge-matrix.json'), 'utf8'));
  const clickthrough = JSON.parse(fs.readFileSync(path.join(evidence, 'click-through.json'), 'utf8'));
  const buttonHit = JSON.parse(fs.readFileSync(path.join(evidence, 'button-hit-dwell.json'), 'utf8'));
  const nativeCleanup = JSON.parse(fs.readFileSync(path.join(evidence, 'native-cleanup.json'), 'utf8'));
  const auxWindow = JSON.parse(fs.readFileSync(path.join(evidence, 'aux-window.json'), 'utf8'));
  const integrationCleanup = JSON.parse(fs.readFileSync(path.join(evidence, 'integration-cleanup.json'), 'utf8'));
  const nativeProcessPass = native.status === 0 && native.stderr.trim() === '';
  const cleanupPass = nativeCleanup.notchDestroyed && nativeCleanup.targetDestroyed && integrationCleanup.electronClosed && integrationCleanup.uncaughtExceptionCount === 0;
  if (!matrix.pass || !clickthrough.pass || !buttonHit.pass || !nativeProcessPass || !cleanupPass || !auxWindow.pass) throw new Error('Stage 2 shape runner failed a required native, renderer, lifecycle, or cleanup criterion.');
  for (const entry of fs.readdirSync(evidence, { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(evidence, entry.name), path.join(evidenceRoot, entry.name));
  }
  console.log(JSON.stringify({ pass: true, captures: matrix.observations.length, clickthrough: clickthrough.underlyingClicks }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
