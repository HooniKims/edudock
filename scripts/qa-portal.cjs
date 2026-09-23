const {PortalAutomation}=require('../src/portal.cjs');const fs=require('node:fs');const path=require('node:path');
(async()=>{
 const events=[];const automation=new PortalAutomation({profile:path.resolve('.qa-edge-'+Date.now()),settings:()=>({autoLogin:true,credentialPath:path.resolve('.env.local'),certificateHint:''}),status:e=>{events.push(e);console.log(e.phase+': '+e.message)}});
 const originalBrowser=automation.browser.bind(automation);automation.browser=async()=>{const c=await originalBrowser();c.on('page',p=>p.on('framenavigated',f=>console.log('Navigation:',f.url().split('?')[0])));return c;};
 try {const result=await automation.openMenu('portal');console.log('Pages:',automation.context.pages().map(p=>p.url().split('?')[0]));const report={result,events,authenticated:false};fs.writeFileSync('artifacts/qa/fresh-edge-login.json',JSON.stringify(report,null,2));console.log(JSON.stringify(result));if(result.phase!=='waiting')process.exitCode=1;}
 finally {if(automation.context)await automation.context.close();}
})();
