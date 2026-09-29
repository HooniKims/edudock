'use strict';

// Builds the Microsoft Store package into release/<version>/. The package is left unsigned:
// Partner Center signs it with the Store's certificate when the submission is published, and the
// Store copy updates itself through the Store (src/updater.cjs turns GitHub updates off there).
// Tile images live in build/appx/.

const builder = require('electron-builder');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manifest = require('../package.json');

const version = manifest.version;
const staging = path.join(os.tmpdir(), `edudock-store-${Date.now()}`);
const target = path.resolve('release', version);
const name = `EduDock-Store-${version}.appx`;

(async () => {
  await builder.build({
    targets: builder.Platform.WINDOWS.createTarget(['appx'], builder.Arch.x64),
    publish: 'never',
    config: { directories: { output: staging }, electronDist: path.resolve('node_modules/electron/dist') },
  });
  const source = path.join(staging, name);
  if (!fs.existsSync(source)) throw new Error(`빌드 결과에 ${name}이(가) 없습니다.`);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(source, path.join(target, name));
  // The unpacked folder lets the package be registered locally for testing without signing.
  const unpacked = path.join(staging, '__appx-x64');
  console.log(`Store 패키지: ${path.join(target, name)}`);
  if (fs.existsSync(unpacked)) console.log(`시험 설치용 폴더: ${unpacked}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
