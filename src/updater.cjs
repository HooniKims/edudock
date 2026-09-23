'use strict';

// Updates come from the project's GitHub Releases.
//
// - Installed copy (NSIS): electron-updater downloads the new installer in the background and
//   installs it when the app quits, or right away when the teacher presses "재시작하여 설치".
// - Portable copy: it cannot replace its own running exe, so it only checks the latest release
//   and offers the download page.
// - Development (not packaged): updates are off.
//
// Nothing here ever installs while a login or 기안 operation is running; restart is always a
// deliberate press.

// Where releases are published. It lives here, not only in package.json, because electron-builder
// strips the "build" section from the packaged package.json — reading it at runtime returned
// nothing in the installed app. A test keeps the two in sync.
const RELEASE_REPOSITORY = Object.freeze({ owner: 'HooniKims', repo: 'edudock' });

const CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

function createUpdater({ app, shell, net, repository, env = process.env, loadAutoUpdater, onChange, now = Date.now }) {
  const mode = !app.isPackaged ? 'development' : env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed';
  const releasesUrl = `https://github.com/${repository.owner}/${repository.repo}/releases/latest`;
  let state = { mode, phase: mode === 'development' ? 'disabled' : 'idle', current: app.getVersion(), available: null, progress: null, message: '', checkedAt: null, releaseUrl: releasesUrl };
  let autoUpdater = null;
  let timers = [];
  let checking = null;

  function set(patch) {
    state = { ...state, ...patch };
    onChange?.(snapshot());
  }

  function snapshot() { return { ...state }; }

  function friendly(error) {
    const text = String(error?.message || error || '');
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|network/i.test(text)) return '인터넷에 연결할 수 없어 업데이트를 확인하지 못했어요.';
    if (/404/.test(text)) return '아직 올라온 릴리즈가 없어요.';
    return '업데이트를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  }

  function installedUpdater() {
    if (autoUpdater) return autoUpdater;
    autoUpdater = loadAutoUpdater();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => set({ phase: 'checking', message: '새 버전을 확인하고 있어요.' }));
    autoUpdater.on('update-not-available', () => set({ phase: 'latest', available: null, message: '최신 버전을 쓰고 있어요.', checkedAt: now() }));
    autoUpdater.on('update-available', info => set({ phase: 'downloading', available: info?.version || null, progress: 0, message: `새 버전 ${info?.version || ''}을 내려받고 있어요.`.replace('  ', ' '), checkedAt: now() }));
    autoUpdater.on('download-progress', progress => set({ phase: 'downloading', progress: Math.round(progress?.percent || 0) }));
    autoUpdater.on('update-downloaded', info => set({ phase: 'ready', available: info?.version || state.available, progress: 100, message: `새 버전 ${info?.version || ''}이 준비됐어요. 재시작하면 설치돼요. 그냥 종료해도 다음 실행 전에 설치됩니다.` }));
    autoUpdater.on('error', error => set({ phase: 'error', progress: null, message: friendly(error), checkedAt: now() }));
    return autoUpdater;
  }

  async function checkPortable() {
    set({ phase: 'checking', message: '새 버전을 확인하고 있어요.' });
    const response = await net.fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EduDock' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    const version = String(release.tag_name || '').replace(/^v/, '');
    const pageUrl = typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : releasesUrl;
    if (isNewer(version, state.current)) set({ phase: 'available', available: version, releaseUrl: pageUrl, message: `새 버전 ${version}이 나왔어요. 포터블 버전은 새 exe를 내려받아 바꿔 주세요.`, checkedAt: now() });
    else set({ phase: 'latest', available: null, message: '최신 버전을 쓰고 있어요.', checkedAt: now() });
  }

  function check() {
    if (mode === 'development') return Promise.resolve(snapshot());
    if (state.phase === 'ready' || state.phase === 'downloading') return Promise.resolve(snapshot());
    if (checking) return checking;
    const run = mode === 'portable' ? checkPortable() : installedUpdater().checkForUpdates();
    checking = Promise.resolve(run)
      .catch(error => set({ phase: 'error', progress: null, message: friendly(error), checkedAt: now() }))
      .then(() => snapshot())
      .finally(() => { checking = null; });
    return checking;
  }

  function start() {
    if (mode === 'development') return;
    const first = setTimeout(() => { void check(); }, CHECK_DELAY_MS);
    const repeat = setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
    first.unref?.();
    repeat.unref?.();
    timers = [first, repeat];
  }

  function stop() {
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    timers = [];
  }

  // The caller marks the app as quitting first so windows that normally hide on close let go.
  function install() {
    if (mode !== 'installed' || state.phase !== 'ready' || !autoUpdater) return false;
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }

  function openReleasePage() {
    return shell.openExternal(state.releaseUrl || releasesUrl);
  }

  return { start, stop, check, install, openReleasePage, get state() { return snapshot(); } };
}

module.exports = { createUpdater, isNewer, parseVersion, RELEASE_REPOSITORY };
