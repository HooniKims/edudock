'use strict';

// Builds the installer and the portable exe into release/<version>/ together with everything a
// GitHub release needs: latest.yml + blockmap for the installed copy's auto-update, and
// SHA256SUMS.txt so a teacher can check what they downloaded.
//
// Each build packages into a fresh staging folder so a locked app.asar from an earlier build
// never collides with the new one.

const builder = require('electron-builder');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manifest = require('../package.json');

const version = manifest.version;
// Staging lives outside the project: editors and tools that watch the folder (Electron-based ones
// open .asar files like directories) otherwise keep app.asar locked and the folder piles up.
const staging = path.join(os.tmpdir(), `edudock-build-${Date.now()}`);
const target = path.resolve('release', version);

// Antivirus scanning a freshly written exe can hold it for a moment; overwriting it then fails
// with EBUSY/EPERM, so the copy is retried briefly instead of failing the whole release.
function copyWithRetry(source, destination) {
  for (let attempt = 1; ; attempt += 1) {
    try { fs.copyFileSync(source, destination); return; }
    catch (error) {
      if (attempt >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

(async () => {
  await builder.build({
    targets: builder.Platform.WINDOWS.createTarget(['nsis', 'portable'], builder.Arch.x64),
    publish: 'never',
    config: { directories: { output: staging }, electronDist: path.resolve('node_modules/electron/dist') },
  });
  const files = [
    `EduDock-Setup-${version}.exe`,
    `EduDock-Setup-${version}.exe.blockmap`,
    `EduDock-Portable-${version}.exe`,
    'latest.yml',
  ];
  fs.mkdirSync(target, { recursive: true });
  for (const name of files) {
    const source = path.join(staging, name);
    if (!fs.existsSync(source)) throw new Error(`빌드 결과에 ${name}이(가) 없습니다.`);
    copyWithRetry(source, path.join(target, name));
  }
  const sums = files.filter(name => name.endsWith('.exe')).map(name => `${sha256(path.join(target, name))}  ${name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(target, 'SHA256SUMS.txt'), sums);
  // Kept for scripts that still look for the installer at the release root.
  copyWithRetry(path.join(target, files[0]), path.resolve('release', files[0]));
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  console.log(`Release files: ${target}`);
  process.stdout.write(sums);
})().catch(error => { console.error(error); process.exitCode = 1; });
