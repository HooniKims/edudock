'use strict';

const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PortalAutomation } = require('../src/portal.cjs');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'artifacts', 'qa', 'v2', '01-auth-entry');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function electronScenario(name, legacySettings) {
  const profile = path.join(root, `.qa-v2-stage1-${name}`);
  await fs.promises.rm(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  if (legacySettings) fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(legacySettings, null, 2));
  const env = { ...process.env, EDUDOCK_QA_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const port = name === 'blank' ? 9338 : 9339;
  const child = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore' });
  let browser;
  try {
    const deadline = Date.now() + 15000;
    while (!browser && Date.now() < deadline) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await pause(250); }
    }
    assert.ok(browser, `Electron CDP did not start for ${name}`);
    const page = browser.contexts()[0].pages()[0];
    assert.ok(page);
    await page.waitForFunction(() => Boolean(window.portal));
    await page.locator('[data-view="settings"]').click();
    await page.locator('#settings-view').waitFor({ state: 'visible' });
    const surface = await page.evaluate(() => ({
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      legacyControls: ['pick-credentials', 'login-form', 'certificate-hint', 'certificate-password', 'use-account-password', 'auto-login'].filter(id => document.getElementById(id)),
      api: Object.keys(window.portal).sort(),
      text: document.body.innerText,
    }));
    assert.equal(surface.passwordInputs, 0);
    assert.deepEqual(surface.legacyControls, []);
    assert.ok(!surface.api.includes('pickCredentials'));
    assert.ok(!surface.api.includes('setLogin'));
    assert.ok(surface.api.includes('cancelAuth'));
    assert.match(surface.text, /공식 인증서 창/);
    assert.doesNotMatch(surface.text, /\.env|파일 선택|pw를 인증서|인증서 비밀번호/);
    const state = await page.evaluate(() => window.portal.getState());
    for (const field of ['credentialPath', 'useAccountPasswordForCertificate', 'certificateHint', 'autoLogin']) assert.ok(!Object.hasOwn(state.settings, field));
    const noOperation = await page.evaluate(() => window.portal.cancelAuth());
    assert.equal(noOperation.ok, false);
    const screenshot = path.join(evidenceDir, `${name}-settings.png`);
    await page.screenshot({ path: screenshot });
    const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    for (const field of ['credentialPath', 'useAccountPasswordForCertificate', 'certificateHint', 'autoLogin']) assert.ok(!Object.hasOwn(persisted, field));
    return { name, screenshot: path.relative(root, screenshot), surface, state, persisted };
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]);
    await fs.promises.rm(profile, { recursive: true, force: true });
  }
}

async function liveCertificateScenario() {
  const profile = path.join(root, `.qa-v2-stage1-edge-${Date.now()}`);
  const events = [];
  const automation = new PortalAutomation({ profile, status: event => events.push(event) });
  let settled = false;
  const task = automation.openMenu('portal').finally(() => { settled = true; });
  try {
    const deadline = Date.now() + 120000;
    while (!events.some(event => event.phase === 'awaiting-user-auth') && !settled && Date.now() < deadline) await pause(250);
    if (!events.some(event => event.phase === 'awaiting-user-auth')) {
      const pages = [];
      for (const [index, candidate] of automation.context.pages().entries()) {
        const url = new URL(candidate.url());
        const screenshot = path.join(evidenceDir, `live-edge-failure-${index}.png`);
        await candidate.screenshot({ path: screenshot });
        pages.push({
          url: `${url.origin}${url.pathname}`,
          screenshot: path.relative(root, screenshot),
          text: (await candidate.locator('body').innerText().catch(() => '')).slice(0, 1500),
          controls: await candidate.locator('input:visible,button:visible').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, id: element.id, type: element.type, text: (element.textContent || element.title || '').trim().slice(0, 120) }))),
          frames: candidate.frames().map(frame => { try { const frameUrl = new URL(frame.url()); return `${frameUrl.origin}${frameUrl.pathname}`; } catch { return frame.url(); } }),
        });
      }
      fs.writeFileSync(path.join(evidenceDir, 'live-edge-failure.json'), JSON.stringify({ events, pages }, null, 2));
      throw new Error(`official certificate password field did not become visible; phases=${events.map(event => event.phase).join(',')}`);
    }
    const page = automation.context.pages().find(candidate => candidate.url().startsWith('https://sen.eduptl.kr/'));
    assert.ok(page);
    assert.equal(await page.locator('input[name="certPassword"]:visible').count(), 1);
    const screenshot = path.join(evidenceDir, 'live-edge-certificate.png');
    await page.screenshot({ path: screenshot });
    const cancel = automation.cancel();
    assert.equal(cancel.ok, true);
    const result = await task;
    assert.equal(result.phase, 'cancelled');
    return { screenshot: path.relative(root, screenshot), passwordFieldVisible: true, passwordValueRead: false, cancelled: true, result, events };
  } finally {
    automation.cancel();
    if (automation.context) await automation.context.close();
    await fs.promises.rm(profile, { recursive: true, force: true });
  }
}

(async () => {
  if (process.argv[2] === '--stage' && process.argv[3] === '3') {
    require('./qa-v2-interaction.cjs');
    return;
  }
  if (process.argv[2] === '--stage' && process.argv[3] === '4') {
    require('./qa-v2-placement.cjs');
    return;
  }
  if (process.argv[2] !== '--stage' || process.argv[3] !== '1') throw new Error('Usage: node scripts/qa-v2.cjs --stage 1');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const blank = await electronScenario('blank', null);
  const legacy = await electronScenario('legacy', {
    credentialPath: 'C:/synthetic/legacy.env',
    useAccountPasswordForCertificate: true,
    certificateHint: 'synthetic legacy identity',
    autoLogin: true,
    orientation: 'horizontal',
    alwaysOnTop: false,
    dock: 'top',
    bounds: { x: 40, y: 50, width: 640, height: 400 },
  });
  const live = await liveCertificateScenario();
  const report = { stage: 1, fixtureProfiles: { blank, legacy }, liveEdge: live, cleanup: 'temporary Electron and Edge profiles removed; official authentication cancelled without credential submission' };
  fs.writeFileSync(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
