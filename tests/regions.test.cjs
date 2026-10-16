const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { REGIONS, regionOrigins, regionHosts, setActiveRegion, activeRegion, activeOrigins, isRegionCode } = require('../src/regions.cjs');
const { sanitizedSettings, cleanPatch } = require('../src/settings.cjs');
const { assertPortalOrigin } = require('../src/certificate.cjs');
const { trusted } = require('../src/portal.cjs');

test('all 17 offices map to their own three hosts, 경북 K-에듀파인 at klef.gbe.kr', () => {
  assert.equal(REGIONS.length, 17);
  assert.equal(new Set(REGIONS.map(region => region.code)).size, 17);
  assert.deepEqual(regionOrigins('sen'), { portal: 'https://sen.eduptl.kr', neis: 'https://sen.neis.go.kr', edufine: 'https://klef.sen.go.kr' });
  assert.deepEqual(regionOrigins('gwe'), { portal: 'https://gwe.eduptl.kr', neis: 'https://gwe.neis.go.kr', edufine: 'https://klef.gwe.go.kr' });
  assert.equal(regionHosts('gbe').edufine, 'klef.gbe.kr');
  for (const bad of ['', 'SEN', 'xyz', null, undefined, 7, 'sen.eduptl.kr']) assert.equal(isRegionCode(bad), false);
});

test('the active office falls back to 서울 for anything that is not an office code', () => {
  try {
    assert.equal(setActiveRegion('gwe'), 'gwe');
    assert.equal(activeOrigins().portal, 'https://gwe.eduptl.kr');
    assert.equal(setActiveRegion('nope'), 'sen');
    assert.equal(setActiveRegion(null), 'sen');
  } finally { setActiveRegion('sen'); }
});

test('a new install has no office; a copy from before offices keeps 서울 but is asked once', () => {
  const fresh = sanitizedSettings({});
  assert.equal(fresh.region, null);
  assert.equal(fresh.regionConfirmed, false);
  const legacy = sanitizedSettings({ schemaVersion: 4, guideCompleted: true, passwordSaved: true });
  assert.equal(legacy.region, 'sen');
  assert.equal(legacy.regionConfirmed, false);
  const answered = sanitizedSettings({ schemaVersion: 4, region: 'gwe', regionConfirmed: true });
  assert.equal(answered.region, 'gwe');
  assert.equal(answered.regionConfirmed, true);
  // A saved file that still says "no office yet" stays that way rather than becoming 서울.
  assert.equal(sanitizedSettings({ ...fresh }).region, null);
  // A confirmation without a real office is not a confirmation.
  assert.equal(sanitizedSettings({ schemaVersion: 4, region: 'xyz', regionConfirmed: true }).regionConfirmed, false);
  assert.deepEqual(cleanPatch({ region: 'evil.example' }), {});
});

test('the password is typed only into the chosen office\'s portal', () => {
  try {
    setActiveRegion('gwe');
    assert.doesNotThrow(() => assertPortalOrigin('https://gwe.eduptl.kr/bpm_lgn_lg00_001.do'));
    assert.throws(() => assertPortalOrigin('https://sen.eduptl.kr/bpm_lgn_lg00_001.do'));
    assert.throws(() => assertPortalOrigin('https://gwe.eduptl.kr.evil.example/'));
    assert.equal(trusted('https://gwe.eduptl.kr/x'), true);
    assert.equal(trusted('https://klef.gwe.go.kr/keris_ui/main.do'), true);
    assert.equal(trusted('https://sen.eduptl.kr/x'), false);
    setActiveRegion('gbe');
    assert.equal(trusted('https://klef.gbe.kr/keris_ui/main.do'), true);
  } finally { setActiveRegion('sen'); }
});

test('every native request carries the active office', async () => {
  const { NativeOrdinaryEdgeBridge } = require('../src/ordinary-edge.cjs');
  const sent = [];
  const bridge = new NativeOrdinaryEdgeBridge({ helperPath: 'h.ps1', timeoutMs: 1000, spawn: () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end(value) { sent.push(value); setImmediate(() => { child.stdout.emit('data', Buffer.from('{"status":"ok","windows":[]}')); child.emit('close', 0); }); }, on() {} };
    child.kill = () => true;
    return child;
  } });
  try {
    setActiveRegion('jje');
    await bridge.run({ command: 'inspect' }, { cancelled: false, cancellation: new Promise(() => {}) });
    assert.equal(JSON.parse(sent[0]).region, 'jje');
  } finally { setActiveRegion('sen'); }
  assert.equal(activeRegion(), 'sen');
});

test('the widget asks for the office before anything else and blocks presses until it is answered', () => {
  const main = fs.readFileSync('src/main.cjs', 'utf8');
  assert.match(main, /if \(needsRegion\(\)\) setTimeout\(\(\) => \{ try \{ showRegionPrompt\(\); \} catch \{\} \}, 1200\);/);
  assert.match(main, /if \(needsRegion\(\)\) \{\n\s+showRegionPrompt\(\);\n\s+return \{ ok: false, phase: 'needs-region'/);
  assert.match(main, /setActiveRegion\(settings\.region\);/);
  const popup = fs.readFileSync('renderer/popup.html', 'utf8');
  assert.match(popup, /id="region-grid"/);
  assert.match(fs.readFileSync('renderer/index.html', 'utf8'), /id="region-select"/);
});
