const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright-core');

const root = path.join(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'qa', 'v2', '02-shape');

(async () => {
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, EDUDOCK_QA_PROFILE: path.join(evidence, 'rapid-button-profile') },
  });
  const stderr = [];
  app.process().stderr?.on('data', chunk => stderr.push(chunk.toString()));
  try {
    const notch = await app.firstWindow();
    const settings = notch.locator('button[data-auxiliary="settings"]');
    await settings.waitFor();
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    const rect = await settings.boundingBox();
    const outside = { x: bounds.x - 80, y: bounds.y + Math.round(bounds.height / 2) };
    const target = { x: bounds.x + Math.round(rect.x + rect.width / 2), y: bounds.y + Math.round(rect.y + rect.height / 2) };
    const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeClick {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
}
'@
[NativeClick]::SetCursorPos(${outside.x},${outside.y})|Out-Null
Start-Sleep -Milliseconds 100
[NativeClick]::SetCursorPos(${target.x},${target.y})|Out-Null
[NativeClick]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
[NativeClick]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
`;
    const auxiliaryPromise = app.waitForEvent('window', { timeout: 3000 });
    const native = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    const auxiliary = await auxiliaryPromise;
    await auxiliary.waitForSelector('#settings-view:not([hidden])');
    const result = {
      invocation: 'node scripts/qa-v2-rapid-button.cjs',
      notchBounds: bounds,
      outsidePointDip: outside,
      settingsButtonPointDip: target,
      cursorDwellBeforeClickMs: 0,
      nativeExitCode: native.status,
      auxiliaryOpened: true,
      activeView: await auxiliary.locator('#settings-view').isVisible() ? 'settings' : 'other',
      pass: native.status === 0,
    };
    fs.writeFileSync(path.join(evidence, 'rapid-settings-button.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
    fs.writeFileSync(path.join(evidence, 'rapid-settings-cleanup.json'), JSON.stringify({ electronClosed: true, stderr: stderr.join(''), uncaughtExceptionCount: (stderr.join('').match(/Uncaught Exception|Object has been destroyed/g) || []).length }, null, 2));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
