'use strict';

// Injected into MAIN; keep this function self-contained. Verified against the site's
// /ui/app/com/main/Index.clx.js (2026-10-12): session_extention and setSessionTimerInit.
// A "Y" acknowledges the primary session only, not individual menus or 2nd authentication.
async function extendNeisInPage() {
  const fail = status => ({ status });
  if (location.origin !== 'https://sen.neis.go.kr') return fail('wrong-origin');
  const pageProblem = () => {
    const text = document.body?.innerText || '';
    if (/세션\s*DB정보가\s*없|정보보호를\s*위해\s*시스템을\s*종료|세션이?\s*만료/.test(text)) return 'expired';
    if (/(?:로그를?\s*확인|널\s*처리|NullPointerException|프로그램.{0,40}오류)/i.test(text)) return 'page-error';
    return null;
  };
  let main;
  const ready = () => {
    const problem = pageProblem();
    if (problem) return problem;
    const info = main?.lookup?.('dmUserInfoSub');
    const minutes = Number(info?.getValue?.('logSesnTime'));
    const timer = String(main?.lookup?.('optTime')?.value || '').match(/(\d+)\s*분\s*(\d+)\s*초/);
    if (!Number.isFinite(minutes) || minutes <= 0 || !timer) return 'not-ready';
    if (Number(timer[1]) * 60 + Number(timer[2]) <= 0) return 'expired';
    return null;
  };
  try {
    const problem = pageProblem();
    if (problem) return fail(problem);
    const apps = globalThis.cpr?.core?.Platform?.INSTANCE?.getAllRunningAppInstances?.() || [];
    const roots = apps.flatMap(app => [app, app?.getRootAppInstance?.()]);
    main = roots.find(app => /^app\/com\/main\/Index(?:\$\d+)?$/.test(app?.id || '') && app?.hasAppMethod?.('setSessionTimerInit'));
    if (!main) return fail('not-ready');
    const initial = ready();
    if (initial) return fail(initial);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response, answer;
    try {
      // Use fetch so jQuery global completion handlers cannot reset a timer on errors.
      response = await fetch('/sessionExtension.do', {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal
      });
      answer = await response.text();
    } finally { clearTimeout(timeout); }
    if (controller.signal.aborted) return fail('timeout');
    if (!response.ok) return fail('http-error');
    if (answer.trim() !== '"Y"') return fail('server-rejected');
    const changed = ready();
    if (changed) return fail(changed);
    main.callAppMethod('setSessionTimerInit');
    // Never reset optTime2 / set2SessionTimer: that is separate authentication.
    const after = ready();
    return fail(after || 'server-accepted');
  } catch (error) {
    // Do not persist response bodies, stack traces, URLs or account data.
    return fail(error?.name === 'AbortError' ? 'timeout' : 'request-failed');
  }
}
