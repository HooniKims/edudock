const fs = require('node:fs');
const path = require('node:path');
const { browserProfile, findBrowserExecutable } = require('./browsers.cjs');
const { activeOrigins } = require('./regions.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function allowPortalHelper(context) {
  for (const page of context.pages()) {
    if (page.url() !== 'edge://permission-request-dialog/') continue;
    const text=await page.locator('body').innerText();
    const origins=[...text.matchAll(/https:\/\/[^\s<>"']+/g)].map(match=>{try{return new URL(match[0]).origin;}catch{return null;}});
    if(origins.includes(activeOrigins().portal) && text.includes('이 장치에서 다른 앱 및 서비스에 액세스')) await page.locator('#allow-button').click({timeout:3000});
  }
}
function assertPortalOrigin(url) {
  if(new URL(url).origin!==activeOrigins().portal)throw new Error('인증서 비밀번호는 선택한 교육청의 업무포털에서만 입력합니다.');
}
async function openCertificateDialog(page, context, status, isCancelled = () => false, deadline = Date.now() + 45000) {
  assertPortalOrigin(page.url());
  const password=page.locator('input[name="certPassword"]:visible');
  let clicked=false;
  status('connecting','브라우저에서 인증서 프로그램을 연결하고 있습니다.');
  while(Date.now()<deadline) {
    if(isCancelled())return false;
    await allowPortalHelper(context);
    assertPortalOrigin(page.url());
    if(await password.count())return true;
    if(!clicked && !await page.locator('.isloading-overlay:visible').count()) {
      try { await page.locator('#btnLgn').click({timeout:600}); clicked=true; }
      catch(error) { if(error.name!=='TimeoutError')throw error; }
    }
    await delay(500);
  }
  throw new Error('인증서 프로그램 연결이 지연됩니다. 브라우저의 연결 권한과 프로그램 설치 상태를 확인하세요.');
}
function diagnostics() {
  // path.join keeps the separators; in a template literal `\M` silently becomes `M`.
  const roots=[process.env['PROGRAMFILES(X86)'],process.env.PROGRAMFILES].filter(Boolean);
  const browser = browserProfile();
  const helperPaths=roots.map(root=>path.join(root,'Ksign','KCase','KCaseAgent.exe'));
  return { browser: browser.id, browserLabel: browser.label, browserInstalled: Boolean(findBrowserExecutable(browser.id)), helperInstalled:helperPaths.some(p=>fs.existsSync(p)), portal:activeOrigins().portal };
}
module.exports={assertPortalOrigin,openCertificateDialog,diagnostics,delay,allowPortalHelper};
