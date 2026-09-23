const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'edudock-edge-cancel-'));
const fixturePath = path.join(temp, 'fixture.json');
const startedAt = '2026-09-20T10:00:00.0000000Z';
writeFileSync(fixturePath, JSON.stringify({
  delayMs: 2000,
  windows: [{
    pid: 411, hwnd: '9001', processName: 'msedge', processStartedAt: startedAt,
    visible: true, rootAvailable: true, rootProcessId: 411,
    addressControls: [{ automationId: 'view_1021', controlType: 'Edit', isPassword: false, value: 'https://sen.eduptl.kr/' }],
    documents: [],
    controls: [{ name: '나이스', role: 'Button', visible: true, enabled: true, patterns: ['Invoke'], processId: 411 }],
  }],
}), 'utf8');

function descendants(parentPid) {
  const command = `@(Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq ${parentPid} | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main() {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(repo, 'src', 'native', 'ordinary-edge.ps1'),
    '-FixturePath', fixturePath, '-TimeoutMs', '4000',
  ], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    command: 'invoke',
    target: { pid: 411, hwnd: '9001', processStartedAt: startedAt },
    action: 'neis',
  }));
  await new Promise(resolve => setTimeout(resolve, 350));
  const childrenBeforeKill = descendants(child.pid);
  assert.deepEqual(childrenBeforeKill, [], 'bridge must not create a worker process');
  child.kill();
  await new Promise(resolve => child.once('close', resolve));
  await new Promise(resolve => setTimeout(resolve, 350));
  const childrenAfterKill = descendants(child.pid);
  assert.deepEqual(childrenAfterKill, [], 'no descendant may survive cancellation');
  assert.equal(stdout, '', 'cancelled process must not emit a late invoke result');
  assert.equal(stderr, '', 'cancelled process must not leak diagnostics');
  process.stdout.write(`${JSON.stringify({
    scenario: 'kill the single native bridge process before delayed fixture invoke',
    bridgePid: child.pid,
    childrenBeforeKill,
    childrenAfterKill,
    lateStdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    verdict: 'PASS',
  })}\n`);
}

main().finally(() => rmSync(temp, { recursive: true, force: true }));
