'use strict';

// Opens only a public test URL, never a portal or authentication window. Leaves tabs open.
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { openBrowserUrl } = require('../src/browsers.cjs');

function inspect(browser) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'qa-browser-selection.ps1'), '-Browser', browser], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
}
(async () => {
  for (const browser of ['aside', 'chrome']) {
    const before = inspect(browser);
    await openBrowserUrl(`https://example.com/?edudock-browser-check=${browser}`, { browser });
    let after;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      after = inspect(browser);
      if (after.testUrlVisible && after.tabCount > before.tabCount) break;
    }
    assert.equal(after.testUrlVisible, true, `${browser}: test URL was not visible in its measured omnibox`);
    assert.ok(after.tabCount > before.tabCount, `${browser}: a new tab was not observed`);
    console.log(JSON.stringify({ browser, beforeTabs: before.tabCount, ...after }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
