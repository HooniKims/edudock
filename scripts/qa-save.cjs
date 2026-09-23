const { _electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const target=path.resolve('artifacts/qa',`draft-save-${Date.now()}.txt`);
  const env={...process.env,EDUDOCK_QA_PROFILE:path.resolve('.qa-save')};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({executablePath:path.join(process.env.LOCALAPPDATA,'Programs/EduDock/EduDock.exe'),args:[],env});
  try {
    const page=await app.firstWindow();
    await page.locator('[data-view=draft]').first().click();
    await page.locator('[name=title]').fill('[샘플·상신금지] 파일 저장 검증');
    await page.locator('[name=purpose]').fill('로컬 파일 저장의 줄바꿈과 한글을 확인하는 가상 문서입니다.');
    await page.locator('[name=attachments]').fill('가상 계획 1부\n가상 안내 1부');
    await page.locator('#generate-button').click();
    await page.locator('#result-body').waitFor({state:'visible'});
    const title=await page.locator('#result-title').inputValue();
    const body=await page.locator('#result-body').inputValue();
    await page.locator('#save-draft').click();
    const mainPid=await app.evaluate(()=>process.pid);
    fs.writeFileSync('artifacts/qa/save-session.json',JSON.stringify({mainPid,target},null,2));
    console.log('NATIVE_SAVE_DIALOG_OPEN');
    const deadline=Date.now()+120000;
    while(!fs.existsSync(target)&&Date.now()<deadline)await page.waitForTimeout(250);
    assert.ok(fs.existsSync(target),'The native save dialog must create the chosen file');
    await page.waitForFunction(()=>document.querySelector('#status-message').textContent.includes('저장했습니다'));
    const saved=fs.readFileSync(target,'utf8');
    const crlf=String.fromCharCode(13,10),bom=String.fromCharCode(65279);
    const expected=bom+title+crlf+crlf+body.split(String.fromCharCode(10)).join(crlf);
    assert.equal(saved,expected);
    const report={installedExecutable:true,nativeSaveDialog:true,utf8Bom:true,koreanPreserved:true,lineBreaksPreserved:true,appendixFormattingPreserved:true,titleSeparatedFromBody:true};
    fs.writeFileSync('artifacts/qa/save-report.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally {await app.evaluate(({app})=>app.exit());}
})().catch(error=>{console.error(error);process.exitCode=1;});
