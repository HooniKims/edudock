// Local HTML fixtures only. No user profile, login, or live portal is opened.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const injected = source.slice(source.indexOf('function pressExtendInPage()'), source.indexOf('// ------------------------------------------------------------------------------------------', source.indexOf('function pressExtendInPage()')));
const cases = [
  ['plain portal button', '<button title="세션 시간 초기화"></button>', true],
  ['generic aria label must not mask title', '<button aria-label="새로 고침" title="세션 시간 초기화"></button>', true],
  ['image-only link', '<a href="#"><img alt="세션 시간 초기화" width="24" height="24"></a>', true],
  ['nested icon title', '<button><span title="세션 시간 초기화">↻</span></button>', true],
  ['SVG accessible title', '<button><svg width="24" height="24"><title>세션 시간 초기화</title></svg></button>', true],
  ['image input', '<input type="image" alt="세션 시간 초기화" width="24" height="24">', true],
  ['whitespace', '<button> 세션\n 시간   초기화 </button>', true],
  ['edufine still works', '<button aria-label="로그아웃 30분 연장"></button>', true],
  ['hidden duplicate skipped', '<button hidden title="세션 시간 초기화"></button><button title="세션 시간 초기화"></button>', true],
  ['disabled skipped', '<button disabled title="세션 시간 초기화"></button>', false],
  ['aria disabled skipped', '<button aria-disabled="true" title="세션 시간 초기화"></button>', false],
  ['invisible skipped', '<button style="visibility:hidden" title="세션 시간 초기화"></button>', false],
  ['logout is never pressed', '<button title="로그아웃">로그아웃</button>', false],
  ['substring is not an action match', '<a>세션 시간 초기화 안내</a>', false],
  ['login page untouched', '<button>인증서 로그인</button>', false],
];
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    for (const [name, html, expected] of cases) {
      await page.setContent(html);
      await page.evaluate(() => {
        window.clicked = [];
        document.querySelectorAll('button,a,input').forEach(el => el.addEventListener('click', event => {
          event.preventDefault(); window.clicked.push(el.hidden ? 'hidden' : 'visible');
        }));
      });
      const result = await page.evaluate(`(() => { ${injected}\nreturn pressExtendInPage(); })()`);
      assert.equal(Boolean(result.clicked), expected, name);
      assert.deepEqual(await page.evaluate(() => window.clicked), expected ? ['visible'] : [], name);
      console.log(`PASS ${name}`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
