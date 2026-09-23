'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const menuIndex = process.argv.indexOf('--menu');
const menu = menuIndex >= 0 ? process.argv[menuIndex + 1] : null;
if (!['neis', 'edufine'].includes(menu)) throw new Error('Use --menu neis or --menu edufine.');

const attempt = path.join(root, 'artifacts', 'qa', 'v2', '06-main-menus', menu, `attempt-${Date.now()}`);
const profile = path.join(attempt, 'profile');
const reportPath = path.join(attempt, 'backend-report.json');
const cleanupPath = path.join(attempt, 'cleanup.json');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const bootstrap = path.join(root, 'scripts', 'qa-v2-primary-bootstrap.cjs');

fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  schemaVersion: 4,
  autoLogin: false,
  certificateDriveHint: null,
  alwaysOnTop: true,
  displayMode: 'expanded',
  placement: {
    edge: 'left',
    monitorId: null,
    offsets: { top: 0.5, right: 0.25, bottom: 0.5, left: 0.5 },
    scale: 1,
    lastEdges: { horizontal: 'top', vertical: 'left' },
  },
  buttons: ['neis', 'edufine', 'attendance', 'trip', 'draft', 'compose'],
}, null, 2));

const child = spawn(electronPath, [bootstrap], {
  cwd: root,
  env: { ...process.env, EDUDOCK_QA_PROFILE: profile, EDUDOCK_QA_PRIMARY_REPORT: reportPath },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: false,
});

let closing = false;
let stderrBytes = 0;
child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
child.stdout.on('data', chunk => { process.stdout.write(chunk); });
child.once('error', error => {
  process.stderr.write(`${error.name || 'Error'}\n`);
  process.exitCode = 1;
});

async function cleanup(exitCode) {
  for (let retry = 0; retry < 10 && fs.existsSync(profile); retry += 1) {
    try { await fs.promises.rm(profile, { recursive: true, force: true }); } catch {}
    if (fs.existsSync(profile)) await new Promise(resolve => setTimeout(resolve, 200));
  }
  const receipt = {
    ownedElectronPid: child.pid,
    ownedElectronExited: child.exitCode !== null,
    ownedProfileRemoved: !fs.existsSync(profile),
    ordinaryEdgeClosed: false,
    installedEduDockClosed: false,
    wxsEditorClosed: false,
    stderrBytes,
    exitCode,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(cleanupPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ type: 'HOST_CLEANUP', attempt: path.relative(root, attempt).replaceAll('\\', '/'), receipt })}\n`);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  if (data.trim().toLowerCase() !== 'close' || closing) return;
  closing = true;
  child.stdin.write('close\n');
});

child.once('exit', async code => {
  await cleanup(code);
  process.exitCode = code || 0;
});

process.once('SIGINT', () => {
  if (!closing) {
    closing = true;
    child.stdin.write('close\n');
  }
});

process.stdout.write(`${JSON.stringify({ type: 'HOST_STARTED', menu, childPid: child.pid, attempt: path.relative(root, attempt).replaceAll('\\', '/') })}\n`);
