const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticLog } = require('../src/diagnostic-log.cjs');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'edudock-log-')); }

test('the problem-report log keeps only its own short fields', () => {
  const dir = tempDir();
  const log = createDiagnosticLog({ directory: dir, now: () => new Date('2026-10-02T01:02:03Z') });
  log.append('press', { id: 'draft', password: 'secret', body: '초안 본문' });
  log.append('status', { phase: 'needs-user', message: '공용서식에서 일반기안문 서식을 찾지 못했습니다.', detail: 'needs-user/korean-ocr-unavailable' });
  const text = fs.readFileSync(path.join(dir, 'diagnostic-log.jsonl'), 'utf8');
  assert.doesNotMatch(text, /secret|초안 본문|password|body/);
  const entries = log.entries();
  assert.deepEqual(entries[0], { at: '2026-10-02T01:02:03.000Z', event: 'press', id: 'draft' });
  assert.equal(entries[1].detail, 'needs-user/korean-ocr-unavailable');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the log is trimmed to its most recent entries and long text is clipped', () => {
  const dir = tempDir();
  const log = createDiagnosticLog({ directory: dir });
  for (let i = 0; i < 650; i += 1) log.append('status', { message: `${i}` });
  log.append('status', { message: 'x'.repeat(1000) });
  const fresh = createDiagnosticLog({ directory: dir }).entries();
  assert.ok(fresh.length <= 600 && fresh.length >= 400);
  assert.equal(fresh.at(-1).message.length, 301);
  assert.notEqual(fresh[0].message, '0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the saved report names the version and edition and says what is left out', () => {
  const dir = tempDir();
  const log = createDiagnosticLog({ directory: dir });
  log.append('press', { id: 'draft' });
  const report = log.report({ appVersion: '0.10.17', edition: '설치형' });
  assert.match(report, /앱 버전: 0\.10\.17 \(설치형\)/);
  assert.match(report, /비밀번호와 초안 내용은 기록하지 않습니다\./);
  assert.match(report, /\| press \| draft/);
  fs.rmSync(dir, { recursive: true, force: true });
});
