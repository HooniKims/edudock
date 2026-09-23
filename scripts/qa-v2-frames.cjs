'use strict';

// Measures how smoothly the notch expands and collapses. The renderer samples
// requestAnimationFrame timestamps while the main process is counted on how often it
// touches the native window (setBounds / setShape / IPC) during one transition.
// Prints a JSON report; exits non-zero when the animation drops frames.

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const evidenceRoot = path.join(root, 'artifacts', 'qa', 'v2', '12-frames');
const evidence = path.join(evidenceRoot, `attempt-${Date.now()}`);
const profile = path.join(evidence, 'profile');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const threshold = { maxIntervalMs: Number(process.env.EDUDOCK_FRAME_MAX_MS || 34), droppedShare: Number(process.env.EDUDOCK_FRAME_DROP_SHARE || 0.1) };

function summarize(samples) {
  const intervals = [];
  for (let i = 1; i < samples.length; i += 1) intervals.push(samples[i] - samples[i - 1]);
  if (intervals.length === 0) return { frames: samples.length, intervals: 0 };
  const sorted = [...intervals].sort((a, b) => a - b);
  const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    frames: samples.length,
    intervals: intervals.length,
    meanMs: Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(2)),
    p50Ms: Number(pick(0.5).toFixed(2)),
    p95Ms: Number(pick(0.95).toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
    over20ms: intervals.filter(v => v > 20).length,
    over34ms: intervals.filter(v => v > 34).length,
  };
}

async function installMainCounters(app) {
  await app.evaluate(({ BrowserWindow }) => {
    if (globalThis.__edudockFrameCounters) return;
    const counters = { setBounds: 0, setShape: 0, send: 0, setBoundsMs: 0, setShapeMs: 0 };
    globalThis.__edudockFrameCounters = counters;
    const target = BrowserWindow.getAllWindows().find(window => window.getTitle() === '업무 도우미');
    const wrap = (object, name, key) => {
      const original = object[name].bind(object);
      object[name] = (...args) => {
        const started = process.hrtime.bigint();
        try { return original(...args); } finally {
          counters[key] += 1;
          counters[`${key}Ms`] = (counters[`${key}Ms`] || 0) + Number(process.hrtime.bigint() - started) / 1e6;
        }
      };
    };
    wrap(target, 'setBounds', 'setBounds');
    if (typeof target.setShape === 'function') wrap(target, 'setShape', 'setShape');
    const send = target.webContents.send.bind(target.webContents);
    target.webContents.send = (...args) => { if (args[0] === 'notch-shape' || args[0] === 'notch-animate') counters.send += 1; return send(...args); };
  });
}

async function readMainCounters(app) {
  return app.evaluate(() => {
    const c = globalThis.__edudockFrameCounters;
    const copy = { ...c };
    for (const key of Object.keys(c)) c[key] = 0;
    return copy;
  });
}

async function sampleTransition(app, notch, trigger, settle) {
  await readMainCounters(app);
  await notch.evaluate(() => {
    window.__frameSamples = [];
    window.__sampling = true;
    const tick = now => { if (!window.__sampling) return; window.__frameSamples.push(now); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await trigger();
  await notch.waitForFunction(state => document.body.dataset.state === state, settle, { timeout: 5000 });
  await pause(80);
  const samples = await notch.evaluate(() => { window.__sampling = false; return window.__frameSamples; });
  const main = await readMainCounters(app);
  return { renderer: summarize(samples), main };
}

(async () => {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    schemaVersion: 3, alwaysOnTop: true, displayMode: 'auto',
    placement: { edge: 'right', monitorId: null, offsets: { top: 0.5, right: 0.4, bottom: 0.5, left: 0.5 }, scale: 1 },
  }, null, 2));
  const env = { ...process.env, EDUDOCK_QA_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: root, env });
  const report = { invocation: 'node scripts/qa-v2-frames.cjs', threshold, runs: [] };
  let pass = true;
  try {
    const first = await app.firstWindow();
    await first.waitForLoadState('domcontentloaded');
    const notch = app.windows().find(page => page.url().endsWith('/notch.html')) || first;
    await notch.waitForFunction(() => Boolean(window.portal) && document.body.dataset.state === 'collapsed');
    await installMainCounters(app);
    await pause(400);

    for (let round = 0; round < 3; round += 1) {
      const expand = await sampleTransition(app, notch, () => notch.evaluate(() => window.portal.notchInteraction({ type: 'expand' })), 'expanded');
      await pause(300);
      const collapse = await sampleTransition(app, notch, () => notch.evaluate(() => window.portal.notchInteraction({ type: 'escape' })), 'collapsed');
      await pause(300);
      report.runs.push({ expand, collapse });
    }
    const worst = report.runs.flatMap(run => [run.expand.renderer, run.collapse.renderer]);
    report.summary = {
      worstMaxMs: Math.max(...worst.map(r => r.maxMs || 0)),
      worstP95Ms: Math.max(...worst.map(r => r.p95Ms || 0)),
      droppedShare: Number((worst.reduce((a, r) => a + (r.over34ms || 0), 0) / Math.max(1, worst.reduce((a, r) => a + (r.intervals || 0), 0))).toFixed(3)),
      mainCallsPerTransition: {
        setBounds: Number((report.runs.reduce((a, run) => a + run.expand.main.setBounds + run.collapse.main.setBounds, 0) / (report.runs.length * 2)).toFixed(1)),
        setShape: Number((report.runs.reduce((a, run) => a + run.expand.main.setShape + run.collapse.main.setShape, 0) / (report.runs.length * 2)).toFixed(1)),
        send: Number((report.runs.reduce((a, run) => a + run.expand.main.send + run.collapse.main.send, 0) / (report.runs.length * 2)).toFixed(1)),
      },
    };
    pass = report.summary.worstMaxMs <= threshold.maxIntervalMs && report.summary.droppedShare <= threshold.droppedShare;
    report.pass = pass;
  } catch (error) {
    report.pass = false;
    report.error = error.stack || String(error);
    pass = false;
  } finally {
    await app.close().catch(() => {});
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  // stdout is a pipe under the QA runner; process.exit would drop the buffered report.
  process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10));
  process.exitCode = pass ? 0 : 1;
})();
