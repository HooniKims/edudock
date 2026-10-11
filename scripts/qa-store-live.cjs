'use strict';

// Runs the real app and its native Edge bridge with the user's saved-login setting.
// The runner never decrypts or prints credentials.
// This only opens the requested screens; it never submits an education-system form.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const useSavedLogin = true;
const args = process.argv.slice(2).filter(arg => arg !== '--saved-login');
const exeIndex = args.indexOf('--exe');
const executablePath = exeIndex < 0 ? null : args.splice(exeIndex, 2)[1];
const actions = args;
if (!actions.length || actions.some(action => !['edufine', 'trip'].includes(action))) {
  throw new Error('Usage: node scripts/qa-store-live.cjs edufine trip');
}
const evidence = path.join(root, 'artifacts', `release-qa-${require('../package.json').version}`, `live-${Date.now()}`);
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edudock-live-'));
const credentials = path.join(profile, 'certificate-password.bin');
const testSettings = { schemaVersion: 4, guideCompleted: true };
if (useSavedLogin) {
  const sourceProfile = path.join(process.env.APPDATA, 'edudock');
  const existing = JSON.parse(fs.readFileSync(path.join(sourceProfile, 'settings.json'), 'utf8'));
  if (existing.autoLogin !== true || existing.passwordSaved !== true) throw new Error('Saved automatic login is not enabled.');
  // Copy only OS-encrypted bytes; the app decrypts through its normal SecretStore.
  // Never return the credential to the test runner or include it in evidence.
  // Electron's OS-encrypted key is stored beside the ciphertext in Local State.
  fs.copyFileSync(path.join(sourceProfile, 'Local State'), path.join(profile, 'Local State'));
  fs.copyFileSync(path.join(sourceProfile, 'certificate-password.bin'), credentials);
  Object.assign(testSettings, { autoLogin: true, passwordSaved: true, certificateDriveHint: existing.certificateDriveHint });
}
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(testSettings));

(async () => {
  const env = { ...process.env, EDUDOCK_QA_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const report = { kind: 'live app IPC + real native Edge bridge', savedLogin: useSavedLogin, startedAt: new Date().toISOString(), actions: [] };
  try {
    app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), cwd: root, env });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const settings = await page.evaluate(() => window.portal.getState()).then(state => state.settings);
    report.autoLoginEnabled = settings.autoLogin === true;
    if (useSavedLogin && (!report.autoLoginEnabled || settings.passwordSaved !== true)) throw new Error('Saved-login test settings were not retained by the app.');
    await page.exposeFunction('recordLiveStatus', status => {
      const item = { phase: status.phase, message: status.message };
      report.actions.at(-1)?.statuses.push(item);
      console.log(JSON.stringify(item));
    });
    await page.evaluate(() => window.portal.onStatus(status => window.recordLiveStatus(status)));
    report.version = await app.evaluate(({ app }) => app.getVersion());
    console.log(JSON.stringify({ version: report.version, evidence }));
    for (const action of actions) {
      const item = { action, statuses: [] };
      report.actions.push(item);
      const timeout = setTimeout(() => page.evaluate(() => window.portal.cancelAuth()).catch(() => {}), 150000);
      try {
        item.result = await page.evaluate(id => window.portal.openMenu(id), action);
        console.log(JSON.stringify({ action, result: item.result }));
      } finally { clearTimeout(timeout); }
      if (item.result?.phase !== 'done') break;
    }
    report.pass = report.actions.length === actions.length && report.actions.every(item => item.result?.phase === 'done');
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(credentials, { force: true });
    fs.rmSync(path.join(profile, 'Local State'), { force: true });
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pass: report.pass === true, report: path.join(evidence, 'report.json') }));
  }
  if (!report.pass) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
