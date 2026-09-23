const {_electron}=require('playwright-core');const path=require('node:path');const fs=require('node:fs');
(async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:path.join(process.env.LOCALAPPDATA,'Programs/EduDock/EduDock.exe'),args:[],env});
 const page=await app.firstWindow();await page.waitForTimeout(1200);
 await page.locator('[data-view=settings]').click();await page.locator('#pick-credentials').click();
 fs.writeFileSync('artifacts/qa/installed-session.json',JSON.stringify({pid:app.process().pid,stage:'file-picker-open'},null,2));
 console.log('FILE_PICKER_OPEN');
 await page.waitForFunction(()=>document.querySelector('#credential-label').textContent.includes('계정 연결됨')||document.querySelector('#credential-label').textContent.includes('인증서 로그인 준비됨'),{},{timeout:120000});
 await page.keyboard.press('Escape');
 await page.locator('[data-menu=portal]').click();
 await page.waitForFunction(()=>!document.querySelector('.connection').matches('[data-busy="true"]'),{},{timeout:65000});
 const state=await page.evaluate(()=>window.portal.getState());
 const status=await page.locator('#status-message').textContent();
 fs.writeFileSync('artifacts/qa/installed-runtime.json',JSON.stringify({installedExecutable:true,version:state.version,credentialAvailable:state.credentialAvailable,certificateReady:state.certificateReady,status},null,2));
 await page.screenshot({path:'artifacts/qa/installed-widget.png'});
 console.log(JSON.stringify({installedExecutable:true,credentialAvailable:state.credentialAvailable,certificateReady:state.certificateReady,status},null,2));
 // Keep the installed widget available for the user's certificate-password response.
 await app.evaluate(({app})=>app.exit());
})().catch(e=>{console.error(e.message);process.exitCode=1});
