const {_electron}=require('playwright-core');const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const assert=require('node:assert/strict');
(async()=>{const env={...process.env,EDUDOCK_QA_PROFILE:path.resolve('.qa-native')};delete env.ELECTRON_RUN_AS_NODE;const app=await _electron.launch({args:['.'],env});try{
 const page=await app.firstWindow();await page.waitForTimeout(1200);
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({x:500,y:150,width:380,height:700});w.show();w.focus();});await page.waitForTimeout(500);
 async function bounds(){return app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());}
 function drag(x,y,dx,dy){const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/native-drag.ps1'),'-StartX',String(x),'-StartY',String(y),'-EndX',String(x+dx),'-EndY',String(y+dy)],{windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
 const before=await bounds();drag(before.x+160,before.y+35,-100,60);await page.waitForTimeout(600);const moved=await bounds();assert.ok(moved.x!==before.x||moved.y!==before.y,'Native header drag must change position');
 const handle=await page.locator('.resize-handle').boundingBox();
 drag(moved.x+Math.round(handle.x+handle.width/2),moved.y+Math.round(handle.y+handle.height/2),50,40);await page.waitForTimeout(600);const resized=await bounds();console.log(JSON.stringify({before,moved,handle,resized}));assert.ok(resized.width>moved.width||resized.height>moved.height,'Mouse resize must change dimensions');
 const a=await app.evaluate(({screen})=>screen.getPrimaryDisplay().workArea);
 await app.evaluate(({BrowserWindow},target)=>BrowserWindow.getAllWindows()[0].setPosition(target.x,target.y),{x:a.x+a.width-resized.width-100,y:200});await page.waitForTimeout(300);const near=await bounds();
 drag(near.x+160,near.y+35,100,0);await page.waitForTimeout(800);const docked=await bounds();assert.equal(docked.x+docked.width,a.x+a.width,'Snap must reach screen edge');
 const report={before,moved,resized,docked,nativeMouseDrag:true,nativeMouseResize:true,edgeSnap:true};fs.writeFileSync('artifacts/qa/native-mouse.json',JSON.stringify(report,null,2));await page.screenshot({path:'artifacts/qa/native-mouse.png'});console.log(JSON.stringify(report,null,2));
 }finally{await app.evaluate(({app})=>app.exit());}})().catch(e=>{console.error(e);process.exitCode=1});
