const { chromium } = require('playwright-core');
const path = require('node:path');
(async () => {
  const context = await chromium.launchPersistentContext(path.join(process.env.LOCALAPPDATA, 'EduDock', 'EdgeProfile'), {
    channel: 'msedge', headless: false, viewport: null, args: ['--remote-debugging-port=9337'],
  });
  const page = context.pages()[0] || await context.newPage();
  page.on('dialog', async dialog => { console.log('Browser dialog type:', dialog.type()); await dialog.dismiss(); });
  await page.goto('https://sen.eduptl.kr', { waitUntil: 'domcontentloaded' });
  await page.locator('#btnLgn').waitFor({ timeout: 30000 });
  await page.locator('#btnLgn').click();
  await page.waitForTimeout(3500);
  console.log('LOGIN_CLICKED', page.url());
  console.log('FRAMES', page.frames().map(f => { try { return new URL(f.url()).pathname; } catch { return ''; } }));
  console.log('VISIBLE_FIELDS', await page.locator('input:visible,button:visible').evaluateAll(es => es.map(e => ({ tag:e.tagName, id:e.id, type:e.type, label:(e.textContent || e.getAttribute('title') || '').trim().slice(0,100) }))));
  console.log('READY_PORT_9337');
  await new Promise(resolve => context.on('close', resolve));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
