'use strict';

// 업무 곁 세션 유지 — keeps 업무포털 and K-에듀파인 signed in while the switch is on.
//
// Every few minutes it looks at the tabs already open on those two sites and, inside each page,
// presses the site's own session-extend button (업무포털: "세션 시간 초기화", K-에듀파인: "로그아웃
// 30분 연장"). Nothing is opened, switched or brought forward, and nothing leaves the browser:
// the switch and a short local log are all it stores.
// NEIS is opt-in and uses the site's primary-session endpoint, never its clock icon.
importScripts('neis.js');

const HOSTS = ['https://sen.eduptl.kr/*', 'https://klef.sen.go.kr/*'];
const NEIS_HOST = 'https://sen.neis.go.kr/*';
const ALARM = 'keepalive';
const PERIOD_MINUTES = 4;
const MAX_LOG = 40;

async function settings() {
  return chrome.storage.local.get({ enabled: false, log: [] });
}

async function appendLog(entries) {
  const { log } = await settings();
  const next = [...entries, ...log].slice(0, MAX_LOG);
  await chrome.storage.local.set({ log: next });
  return next;
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 0.2 });
}

// ---- Runs inside the page (must be self-contained) ----------------------------------------
// The time left before logout, as the page itself shows it.
function readTimerInPage() {
  const text = (document.body && document.body.innerText) || '';
  const portal = text.match(/(\d{1,2}:\d{2})\s*후에\s*로그아웃/);
  if (portal) return portal[1];
  // K-에듀파인 (Nexacro): "로그아웃 잔여시간은 40:00 입니다." in the timer's aria-label.
  for (const el of document.querySelectorAll('[aria-label*="잔여시간"]')) {
    const hit = el.getAttribute('aria-label').match(/(\d{1,3}:\d{2})/);
    if (hit) return hit[1];
  }
  return null;
}

function pressExtendInPage() {
  const LABELS = ['세션 시간 초기화', '로그아웃 30분 연장', '세션 연장', '로그인 연장', '시간 연장', '시간연장'];
  const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
  const nodes = [...document.querySelectorAll('button, a, [role="button"], input[type="button"]')];
  const target = nodes.find(el => LABELS.includes(label(el)));
  if (!target) return { clicked: null };
  // K-에듀파인 is a Nexacro page: its buttons react to mouse events, not to element.click() alone.
  const box = target.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, view: window, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Ctor(type, { ...at, pointerId: 1, isPrimary: true }));
  }
  target.click();
  return { clicked: label(target) };
}
// ------------------------------------------------------------------------------------------

async function sessionTabs() {
  const hosts = [...HOSTS];
  if (await chrome.permissions.contains({ origins: [NEIS_HOST] })) hosts.push(NEIS_HOST);
  const tabs = await chrome.tabs.query({ url: hosts });
  return tabs.filter(tab => !tab.discarded);
}

async function inTab(tabId, func, world = 'ISOLATED') {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, world });
  return result ? result.result : null;
}

async function withTimeout(promise, ms, what) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: ${ms / 1000}초 안에 응답 없음`)), ms); })]); }
  finally { clearTimeout(timer); }
}

let pendingRun;
function keepAlive(reason) {
  if (!pendingRun) pendingRun = runKeepAlive(reason).finally(() => { pendingRun = null; });
  return pendingRun;
}

async function runKeepAlive(reason) {
  const at = new Date().toISOString();
  const entries = [];
  for (const tab of await sessionTabs()) {
    const host = new URL(tab.url).host;
    // Edge's sleeping tabs freeze the page, and a frozen page cannot press anything while the
    // server-side session keeps running out. Ask the browser to keep these tabs awake.
    try { if (tab.autoDiscardable !== false) await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
    if (tab.frozen) { entries.push({ at, reason, host, error: '탭이 절전 모드라 누르지 못함' }); continue; }
    try {
      if (host === 'sen.neis.go.kr') {
        const result = await withTimeout(inTab(tab.id, extendNeisInPage, 'MAIN'), 10000, '나이스 연장');
        entries.push({ at, reason, host, status: result?.status || 'request-failed' });
        continue;
      }
      const before = await withTimeout(inTab(tab.id, readTimerInPage), 5000, '남은 시간 읽기');
      const pressed = await withTimeout(inTab(tab.id, pressExtendInPage), 5000, '연장 누르기');
      await new Promise(resolve => setTimeout(resolve, 1500));
      const after = pressed && pressed.clicked ? await withTimeout(inTab(tab.id, readTimerInPage), 5000, '남은 시간 읽기') : before;
      entries.push({ at, reason, host, clicked: pressed ? pressed.clicked : null, before, after });
    } catch (error) {
      const text = String(error && error.message || error);
      entries.push({ at, reason, host, error: /응답 없음/.test(text) ? '탭 응답 시간 초과' : '탭 접근 또는 실행 실패' });
    }
  }
  if (!entries.length) entries.push({ at, reason, note: '연장 가능한 탭이 없음 · 로그인 및 사이트 접근 허용을 확인해 주세요' });
  await appendLog(entries);
  return entries;
}

chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM) return;
  if ((await settings()).enabled) await keepAlive('alarm');
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  (async () => {
    if (message?.type === 'set-enabled') {
      await chrome.storage.local.set({ enabled: message.enabled === true });
      await ensureAlarm();
      if (message.enabled === true) await keepAlive('switched-on');
      return { ok: true };
    }
    if (message?.type === 'run-now') return { ok: true, entries: await keepAlive('manual') };
    if (message?.type === 'state') return { ok: true, ...(await settings()), neisAllowed: await chrome.permissions.contains({ origins: [NEIS_HOST] }) };
    return { ok: false };
  })().then(reply, error => reply({ ok: false, error: String(error && error.message || error) }));
  return true;
});
