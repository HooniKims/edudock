const test=require('node:test');
const assert=require('node:assert/strict');
const {parseCredentials}=require('../src/credentials.cjs');
const {generateDraft,dateLabel}=require('../src/drafts.cjs');
const {cleanPatch}=require('../src/settings.cjs');
const {trusted}=require('../src/portal.cjs');
test('colon and dotenv credentials, explicit certificate password stays distinct',()=>{
  assert.deepEqual(parseCredentials('id: example\npw: pass:with=punctuation'),{username:'example',password:'pass:with=punctuation',certificatePassword:''});
  assert.equal(parseCredentials('CERT_PASSWORD="cert=pass"').certificatePassword,'cert=pass');
});
test('official format preserves confirmed facts and appendix punctuation',()=>{
 const draft=generateDraft({kind:'official',title:'[샘플·상신금지] 협의회',purpose:'협의회를 운영하고자 합니다.',basis:'학교-123(2026. 9. 1.)',date:'2026-09-23',startTime:'15:30',place:'협의실',attachments:'운영계획 1부\n안내자료 1부'});
 assert.match(draft.body,/2026\. 9\. 23\.\(수\) 15:30/);
 assert.ok(!draft.body.includes('16:00'));
 assert.match(draft.body,/\n\n붙임  1\. 운영계획 1부\n      2\. 안내자료 1부\.  끝\.$/);
 assert.equal(draft.metadata.keywords,'');
});
test('missing facts are not invented and date/time validation rejects impossible values',()=>{
 const draft=generateDraft({kind:'official',title:'검토',purpose:'협의회를 개최합니다.'});
 assert.equal(draft.body,'1. 협의회를 개최합니다.  끝.');
 assert.ok(draft.warnings.includes('일시 미확정'));
 assert.throws(()=>dateLabel('2026-02-30'));
 assert.throws(()=>generateDraft({kind:'trip',title:'출장',purpose:'연수',startTime:'15:00',endTime:'14:00'}));
});
test('trip and attendance drafts include only supplied information',()=>{
 assert.equal(generateDraft({kind:'trip',title:'연수',purpose:'직무연수',place:'교육청'}).body,'출장 목적: 직무연수\n출장지: 교육청');
 assert.equal(generateDraft({kind:'attendance',title:'연가',purpose:'개인 사유',leaveType:'연가'}).body,'근무상황 종류: 연가\n사유: 개인 사유');
});
test('renderer settings cannot set arbitrary paths or inject secrets',()=>{
  assert.deepEqual(cleanPatch({credentialPath:'C:/sensitive',password:'never',certificateHint:'name',useAccountPasswordForCertificate:true,orientation:'other',alwaysOnTop:true,placement:{edge:'bottom',scale:1.2}}),{alwaysOnTop:true,placement:{edge:'bottom',scale:1.2}});
});
test('navigation trust cannot be expanded by hostname suffix tricks',()=>{
 assert.equal(trusted('https://sen.eduptl.kr/path'),true);
 assert.equal(trusted('https://sen.eduptl.kr.evil.example/path'),false);
 assert.equal(trusted('http://sen.eduptl.kr'),false);
});
test('certificate credentials are pinned to the exact portal origin',()=>{
 const {assertPortalOrigin}=require('../src/certificate.cjs');
 assert.doesNotThrow(()=>assertPortalOrigin('https://sen.eduptl.kr/bpm_lgn_lg00_001.do'));
 for(const url of ['https://different.sen.go.kr','https://sen.eduptl.kr.evil.example','http://sen.eduptl.kr','https://sen.eduptl.kr:444'])assert.throws(()=>assertPortalOrigin(url));
});
test('legacy login settings are removed while safe window settings migrate',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {loadSettings}=require('../src/settings.cjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'edudock-settings-'));
 fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({credentialPath:'C:/legacy.env',useAccountPasswordForCertificate:true,certificateHint:'legacy user',autoLogin:true,orientation:'horizontal',alwaysOnTop:false,dock:'top',bounds:{x:10,y:20,width:640,height:400}}));
  const actual=loadSettings(directory);assert.deepEqual(actual,{schemaVersion:4,autoLogin:false,guideCompleted:false,passwordSaved:false,certificateDriveHint:null,alwaysOnTop:false,opacity:1,placement:{edge:'top',monitorId:null,offsets:{top:0.5,right:0.5,bottom:0.5,left:0.5},scale:1,lastEdges:{horizontal:'top',vertical:'right'}},displayMode:'expanded',buttons:['neis','edufine','attendance','trip','draft','compose']});
 fs.unlinkSync(path.join(directory,'settings.json'));fs.rmdirSync(directory);
});
test('fresh settings default to the right-edge vertical notch',()=>{
 const {sanitizedSettings}=require('../src/settings.cjs');
 assert.equal(sanitizedSettings({}).placement.edge,'right');
});
