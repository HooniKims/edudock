'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const BROWSERS = require('./browsers.json');
const registryCache = new Map();
let selectedBrowser = 'edge';

function normalizeBrowser(value) {
  return BROWSERS.some(browser => browser.id === value) ? value : 'edge';
}
function setActiveBrowser(value) { selectedBrowser = normalizeBrowser(value); }
function browserProfile(value = selectedBrowser) { return BROWSERS.find(browser => browser.id === normalizeBrowser(value)); }

function readRegistryCommand(key) {
  if (process.platform !== 'win32') return null;
  const cached = registryCache.get(key);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  let value = null;
  try {
    const output = execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    value = output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim() || null;
  } catch {}
  registryCache.set(key, { at: Date.now(), value });
  return value;
}
function findBrowserExecutable(value, { env = process.env, exists = fs.existsSync, readRegistry = readRegistryCommand } = {}) {
  const browser = browserProfile(value);
  const candidates = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root, ...browser.relativePath));
  const standard = candidates.find(candidate => exists(candidate));
  if (standard) return standard;
  for (const hive of ['HKCU', 'HKLM']) {
    for (const branch of ['Software', 'Software\\WOW6432Node']) {
      const command = readRegistry(`${hive}\\${branch}\\Clients\\StartMenuInternet\\${browser.registryClient}\\shell\\open\\command`);
      if (command) {
        const expanded = command.replace(/%([^%]+)%/g, (match, key) => env[key] || match);
        const executable = expanded.match(/^"([^"]+\.exe)"/i)?.[1] || expanded.match(/^(.+?\.exe)(?:\s|$)/i)?.[1];
        if (executable && path.win32.basename(executable).toLowerCase() === browser.executable.toLowerCase()) candidates.push(executable);
      }
    }
  }
  return candidates.find(candidate => exists(candidate)) || null;
}
function browserAvailability(options) {
  return BROWSERS.map(({ id, label }) => ({ id, label, installed: Boolean(findBrowserExecutable(id, options)) }));
}
function requireBrowser(value = selectedBrowser, options) {
  const browser = browserProfile(value);
  const executable = findBrowserExecutable(browser.id, options);
  if (!executable) throw new Error(`${browser.label}: 설치되지 않았습니다. 브라우저를 설치하거나 설정에서 다른 브라우저를 선택해 주세요.`);
  return { ...browser, executablePath: executable };
}
async function openBrowserUrl(url, { browser = selectedBrowser, openExternal, spawnProcess = spawn, discovery } = {}) {
  const profile = requireBrowser(browser, discovery);
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('열 수 없는 주소입니다.');
  // Keep Edge's existing profile and protocol handler behaviour.
  if (profile.protocol) return openExternal(`${profile.protocol}${url}`);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(profile.executablePath, ['--new-tab', url], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => reject(new Error(`${profile.label} 실행에 실패했습니다. 설치 상태를 확인해 주세요.`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { BROWSERS, normalizeBrowser, setActiveBrowser, browserProfile, findBrowserExecutable, browserAvailability, requireBrowser, openBrowserUrl };
