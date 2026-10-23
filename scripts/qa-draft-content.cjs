'use strict';

// Exercise the real renderer and disk store in an isolated headless Edge session.
// Portal navigation is stubbed: this QA never opens or writes a real approval document.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');
const { createSavedDrafts } = require('../src/saved-drafts.cjs');
const { generateDraft } = require('../src/drafts.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edudock-content-qa-'));
  const evidence = path.resolve(__dirname, '../artifacts/qa/draft-content');
  fs.mkdirSync(evidence, { recursive: true });
  let store = createSavedDrafts({ directory });
  let generations = 0;
  let failSave = false;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('draftQa', (method, payload) => {
      if (method === 'draftsList') return store.list();
      if (method === 'draftsSave') {
        if (failSave) throw new Error('QA 저장 실패');
        return store.save(payload);
      }
      if (method === 'draftsRemove') return store.remove(payload);
      if (method === 'generateDraft') { generations++; return generateDraft(payload); }
      throw new Error(`Unexpected call: ${method}`);
    });
    await page.addInitScript(() => {
      window.portal = {
        getState: async () => ({ settings: { placement: { edge: 'right' } } }),
        fitWindow: async () => {},
        ...Object.fromEntries(['draftsList', 'draftsSave', 'draftsRemove', 'generateDraft'].map(method => [method, payload => window.draftQa(method, payload)])),
      };
    });
    await page.goto(`${pathToFileURL(path.resolve(__dirname, '../renderer/index.html'))}?auxiliary=1&view=draft`);
    await page.waitForFunction(() => document.getElementById('saved-empty').hidden === false);
    assert.equal(await page.locator('[name="basis"]').count(), 0);
    const title = page.locator('[name="title"]');
    const body = page.locator('[name="purpose"]');
    const original = '1. 관련: 학교 운영 계획\n\n2. 협의 내용\n  가. 입력 중인 문장  \n    (1) 아직 작성 중';
    await title.fill('내용 저장 확인');
    await body.fill(original);
    await page.locator('#save-content').click();
    await page.waitForFunction(() => document.querySelectorAll('.saved-pick').length === 1);
    assert.equal(generations, 0, 'saving content must not generate or format a draft');
    assert.equal(store.list()[0].body, original);
    assert.equal(await page.locator('#result-body').inputValue(), original);

    store = createSavedDrafts({ directory });
    await page.reload();
    await page.locator('.saved-pick').click();
    assert.equal(await body.inputValue(), original);
    assert.equal(await title.inputValue(), '내용 저장 확인');
    const edited = `${original}\n  나. 수정한 내용`;
    await body.fill(edited);
    await page.locator('#save-content').click();
    await page.waitForFunction(value => document.getElementById('result-body').value === value, edited);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].body, edited);

    await page.locator('#result-body').fill(`${edited}\n3. 결과에서 수정`);
    await page.locator('#keep-draft').click();
    await page.waitForFunction(() => !document.getElementById('keep-draft').disabled);
    assert.equal(store.list()[0].body, `${edited}\n3. 결과에서 수정`);

    failSave = true;
    await body.fill('저장 실패 후에도 남아 있어야 하는 내용');
    await page.locator('#save-content').click();
    await page.waitForFunction(() => document.querySelector('.connection').dataset.phase === 'error');
    assert.equal(await body.inputValue(), '저장 실패 후에도 남아 있어야 하는 내용');
    assert.equal(await page.locator('#save-content').isEnabled(), true);
    assert.equal(store.list()[0].body, `${edited}\n3. 결과에서 수정`);
    failSave = false;

    const longBody = '1. 관련: 본문에 직접 입력\n  가. ' + '긴문장자동줄바꿈확인'.repeat(100) + '\n    (1) 들여쓰기 유지';
    await body.fill(longBody);
    await page.locator('#save-content').click();
    await page.waitForFunction(value => document.getElementById('result-body').value === value, longBody);
    const dimensions = [];
    for (const width of [1080, 520, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => {
        const result = document.getElementById('result-body');
        return result.scrollHeight <= result.clientHeight + 1;
      });
      for (const selector of ['[name="purpose"]', '#result-body']) {
        const size = await page.locator(selector).evaluate(node => ({
          clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
          whiteSpace: getComputedStyle(node).whiteSpace, textAlign: getComputedStyle(node).textAlign,
        }));
        assert.ok(size.scrollWidth <= size.clientWidth + 1, `${selector} overflows at ${width}px`);
        assert.equal(size.whiteSpace, 'pre-wrap');
        assert.equal(size.textAlign, 'left');
        dimensions.push({ width, selector, ...size });
      }
      assert.equal(await body.inputValue(), longBody);
      await page.screenshot({ path: path.join(evidence, `width-${width}.png`) });
    }
    assert.equal(store.list()[0].body, longBody, 'visual wrapping must not alter stored text');

    await page.setViewportSize({ width: 1080, height: 900 });
    await body.fill('1. 관련: 학교 운영 계획\n2. 협의회를 개최합니다.');
    await page.locator('#generate-button').click();
    await page.waitForFunction(() => document.getElementById('result-body').value.endsWith('끝.'));
    assert.equal(generations, 1);
    assert.ok(!(await page.locator('#draft-warnings').textContent()).includes('관련 근거가 없어'));
    assert.equal(store.list()[0].body, longBody, 'generating must not overwrite saved content');
    await page.screenshot({ path: path.join(evidence, 'generated.png') });
    await page.locator('.saved-remove').click();
    await page.waitForFunction(() => !document.getElementById('saved-empty').hidden);
    assert.equal(store.list().length, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ pass: true, generations, dimensions }, null, 2));
    console.log('PASS: raw save, restart, edit, result save, failure recovery, wrapping, generate, delete');
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
