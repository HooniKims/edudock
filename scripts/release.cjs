'use strict';

// npm run release — publishes the version in package.json as a GitHub release.
//
// Refuses to publish anything that is not exactly what is committed and pushed: the working tree
// must be clean, HEAD must be on the remote, the tag must be new and CHANGELOG.md must describe
// the version. Then it runs the tests, builds both exe files and uploads them with latest.yml
// (read by the installed copy's auto-update) and SHA256SUMS.txt.
//
//   npm run release              build and publish
//   npm run release -- --draft   publish as a draft to check the page before going live

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const version = manifest.version;
const tag = `v${version}`;
const draft = process.argv.includes('--draft');
const gh = process.env.GH_PATH || (fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe') ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh');

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], ...options });
}

function fail(message) {
  console.error(`\n릴리즈 중단: ${message}`);
  process.exit(1);
}

function releaseNotes() {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const heading = new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?.*$`, 'm');
  const match = heading.exec(changelog);
  if (!match) fail(`CHANGELOG.md에 "## ${version}" 항목이 없습니다.`);
  const rest = changelog.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  if (!body) fail(`CHANGELOG.md의 ${version} 항목이 비어 있습니다.`);
  return `${body}\n\n---\n\n**어떤 파일을 받나요?**\n- \`EduDock-Setup-${version}.exe\` — 설치형(권장). 이후 새 버전을 자동으로 받습니다.\n- \`EduDock-Portable-${version}.exe\` — 설치 없이 실행. 새 버전은 알림만 합니다.\n\n처음 실행할 때 Windows "PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누르세요. 파일 확인용 해시는 \`SHA256SUMS.txt\`에 있습니다.\n`;
}

// ---- Preconditions ---------------------------------------------------------------------------
const { owner, repo } = manifest.build.publish;
if (!owner || owner.startsWith('__')) fail('package.json의 build.publish.owner가 설정되지 않았습니다.');
try { run(gh, ['auth', 'status']); } catch { fail('GitHub CLI 로그인이 필요합니다: gh auth login'); }
if (run('git', ['status', '--porcelain']).trim()) fail('커밋하지 않은 변경이 있습니다. 먼저 커밋하세요.');
run('git', ['fetch', '--tags', 'origin']);
const head = run('git', ['rev-parse', 'HEAD']).trim();
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const remoteHead = run('git', ['rev-parse', `origin/${branch}`]).trim();
if (head !== remoteHead) fail(`HEAD가 origin/${branch}와 다릅니다. 먼저 push 하세요.`);
if (run('git', ['tag', '--list', tag]).trim()) fail(`${tag} 태그가 이미 있습니다. package.json 버전을 올리세요.`);
const notes = releaseNotes();

// ---- Test and build --------------------------------------------------------------------------
console.log(`\n▶ ${tag} 테스트`);
run('npm', ['test'], { inherit: true, shell: true });
console.log(`\n▶ ${tag} 빌드`);
run('node', ['scripts/build.cjs'], { inherit: true });

const dir = path.join(root, 'release', version);
const assets = [`EduDock-Setup-${version}.exe`, `EduDock-Setup-${version}.exe.blockmap`, `EduDock-Portable-${version}.exe`, 'latest.yml', 'SHA256SUMS.txt'].map(name => path.join(dir, name));
for (const file of assets) if (!fs.existsSync(file)) fail(`${path.basename(file)} 파일이 없습니다.`);
const latest = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
if (!latest.includes(`version: ${version}`)) fail('latest.yml의 버전이 package.json과 다릅니다.');

// ---- Publish ---------------------------------------------------------------------------------
const notesFile = path.join(os.tmpdir(), `edudock-release-${version}.md`);
fs.writeFileSync(notesFile, notes, 'utf8');
console.log(`\n▶ ${owner}/${repo} 에 ${tag} ${draft ? '초안' : '릴리즈'} 게시`);
run(gh, ['release', 'create', tag, ...assets, '--repo', `${owner}/${repo}`, '--target', head, '--title', `업무포털 도우미 ${version}`, '--notes-file', notesFile, ...(draft ? ['--draft'] : [])], { inherit: true });
fs.rmSync(notesFile, { force: true });
console.log(`\n완료: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
