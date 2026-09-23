const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const env = { ...process.env, EDUDOCK_QA_PROFILE: process.env.EDUDOCK_QA_PROFILE || path.resolve('.qa-profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync('artifacts/qa', { recursive: true });
  const app = await electron.launch({ executablePath: process.env.EDUDOCK_EXECUTABLE, args: process.env.EDUDOCK_EXECUTABLE ? [] : ['.'], env });
  const errors = [];
  try {
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    assert.ok(notch.url().endsWith('/notch.html'), `expected notch window, got ${notch.url()}`);
    notch.on('pageerror', error => errors.push(error.message));
    await notch.waitForFunction(() => Boolean(window.portal));
    await notch.evaluate(() => window.portal.settings({ displayMode: 'expanded' }));
    await notch.waitForFunction(() => document.body.dataset.state === 'expanded');
    await notch.locator('button[data-auxiliary="draft"]').waitFor();

    await notch.evaluate(() => window.portal.settings({ placement: { edge: 'top' } }));
    await notch.waitForFunction(() => document.body.dataset.edge === 'top');
    const top = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '업무 도우미').getBounds());
    await notch.screenshot({ path: 'artifacts/qa/notch-top.png', omitBackground: true });

    await notch.evaluate(() => window.portal.settings({ placement: { edge: 'right' } }));
    await notch.waitForFunction(() => document.body.dataset.edge === 'right');
    const right = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === '업무 도우미').getBounds());
    await notch.screenshot({ path: 'artifacts/qa/notch-right.png', omitBackground: true });
    assert.ok(top.width > top.height);
    assert.ok(right.height > right.width);

    await notch.locator('button[data-auxiliary="draft"]').click();
    let auxiliary;
    for (let attempt = 0; attempt < 50 && !auxiliary; attempt += 1) {
      auxiliary = app.windows().find(page => page.url().includes('/index.html'));
      if (!auxiliary) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(auxiliary, 'draft auxiliary window did not open');
    auxiliary.on('pageerror', error => errors.push(error.message));
    await auxiliary.waitForSelector('#draft-view:not([hidden])');
    await auxiliary.locator('[name=title]').fill('[샘플·상신금지] 학년 협의회');
    await auxiliary.locator('[name=purpose]').fill('수업 자료를 공유하기 위한 협의회를 운영합니다.');
    await auxiliary.locator('[name=date]').fill('2026-09-23');
    await auxiliary.locator('[name=place]').fill('협의실');
    await auxiliary.locator('#generate-button').click();
    await auxiliary.locator('#result-body').waitFor({ state: 'visible' });
    assert.ok((await auxiliary.locator('#result-body').inputValue()).length > 20);
    await auxiliary.locator('#copy-draft').click();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(copied, /\[샘플·상신금지\] 학년 협의회/);

    await notch.locator('button[data-auxiliary="settings"]').click();
    await auxiliary.waitForSelector('#settings-view:not([hidden])');
    await notch.locator('button[data-auxiliary="draft"]').click();
    await auxiliary.waitForSelector('#draft-view:not([hidden])');
    assert.equal(await auxiliary.locator('[name=title]').inputValue(), '[샘플·상신금지] 학년 협의회');
    await auxiliary.screenshot({ path: 'artifacts/qa/draft.png' });

    assert.deepEqual(errors, []);
    const report = {
      native: true,
      notchTop: top,
      notchRight: right,
      draftGenerated: true,
      clipboardVerified: true,
      auxiliaryReused: app.windows().filter(page => page.url().includes('/index.html')).length === 1,
      draftPreserved: true,
      errors,
    };
    fs.writeFileSync('artifacts/qa/report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
