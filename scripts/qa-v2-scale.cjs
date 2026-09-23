const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const { getNotchShape } = require('../src/notch-geometry.cjs');

const root = path.join(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'qa', 'v2', '02-shape');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const results = [];
  try {
    for (const scale of [0.85, 1.5]) {
      const shape = getNotchShape({ edge: 'right', state: 'expanded', scale });
      const page = await browser.newPage({ viewport: { width: shape.width, height: shape.height } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.join(root, 'renderer', 'notch.html')).href);
      await page.evaluate(payload => applyShape(payload), shape);
      await page.evaluate(() => document.fonts.ready);
      const buttons = await page.locator('.actions button').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
      }));
      const file = path.join(evidence, `right-scale-${String(scale).replace('.', '_')}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      const expected = 40 * (shape.depth / 56);
      const pass = buttons.length === 7 && buttons.every(button => Math.abs(button.width - expected) < 0.1 && Math.abs(button.height - expected) < 0.1) && errors.length === 0;
      results.push({ scale, viewport: { width: shape.width, height: shape.height }, expectedActionSize: expected, buttons, errors, file: path.relative(root, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, pass });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const report = { invocation: 'node scripts/qa-v2-scale.cjs', results, pass: results.every(result => result.pass), cleanup: { browserClosed: true } };
  fs.writeFileSync(path.join(evidence, 'scale-extremes.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
