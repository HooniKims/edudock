'use strict';

const { spawn: spawnProcess } = require('node:child_process');

// One long-lived PowerShell process per helper. Spawning per call cost roughly 700ms of
// process start plus Add-Type compilation on top of the real UI Automation work, and both
// the login flow and the draft handoff poll continuously, so that overhead dominated.
//
// Protocol: one base64 request per line, exactly one response line, in order. Responses are
// matched by order, so only one request may be in flight; on timeout, cancellation or any
// protocol doubt the worker is killed and the next call starts a fresh one.

const MAX_BUFFER_BYTES = 256 * 1024;

class NativeHelperWorker {
  constructor({ helperPath, servePath, spawn = spawnProcess, timeoutMs = 10000, errors }) {
    this.helperPath = helperPath;
    this.servePath = servePath;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.errors = errors;
    this.worker = null;
    this.chain = Promise.resolve();
  }

  stop(worker = this.worker) {
    if (!worker) return;
    if (this.worker === worker) this.worker = null;
    try { worker.child.kill(); } catch {}
  }

  ensure() {
    if (this.worker) return this.worker;
    const child = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.servePath, '-Helper', this.helperPath], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const worker = { child, buffer: '', waiter: null, answered: false };
    const fail = () => {
      const waiter = worker.waiter;
      worker.waiter = null;
      if (this.worker === worker) this.worker = null;
      if (waiter) waiter.reject(Object.assign(this.errors.failed(), { workerFault: !worker.answered }));
    };
    child.stdout.on('data', chunk => {
      worker.buffer += chunk.toString('utf8');
      if (worker.buffer.length > MAX_BUFFER_BYTES) { this.stop(worker); fail(); return; }
      let index = worker.buffer.indexOf('\n');
      while (index >= 0) {
        const line = worker.buffer.slice(0, index).trim();
        worker.buffer = worker.buffer.slice(index + 1);
        if (line) {
          worker.answered = true;
          const waiter = worker.waiter;
          worker.waiter = null;
          if (waiter) waiter.resolve(line);
        }
        index = worker.buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', fail);
    child.on('close', fail);
    this.worker = worker;
    return worker;
  }

  send(body, operation) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = this.ensure();
      } catch (error) {
        reject(Object.assign(error, { workerFault: true }));
        return;
      }
      if (worker.waiter) {
        reject(Object.assign(this.errors.failed(), { workerFault: true }));
        return;
      }
      let settled = false;
      let timer;
      let unsubscribe;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        if (worker.waiter && worker.waiter.owner === finish) worker.waiter = null;
        if (error) {
          this.stop(worker);
          reject(error);
        } else resolve(value);
      };
      timer = setTimeout(() => finish(this.errors.timeout()), this.timeoutMs);
      unsubscribe = operation?.onCancel?.(() => finish(this.errors.cancelled()));
      const cancellation = operation?.cancellation || operation?.cancellationPromise;
      if (cancellation && typeof cancellation.then === 'function') {
        Promise.resolve(cancellation).then(() => finish(this.errors.cancelled()), () => finish(this.errors.cancelled()));
      }
      worker.waiter = { owner: finish, resolve: line => finish(null, line), reject: error => finish(error) };
      try {
        worker.child.stdin.write(`${Buffer.from(body, 'utf8').toString('base64')}\n`);
      } catch (error) {
        finish(Object.assign(error, { workerFault: true }));
      }
    });
  }

  // Serialised: responses are matched by order, so a second request must wait.
  run(body, operation) {
    const attempt = this.chain.then(() => this.send(body, operation), () => this.send(body, operation));
    this.chain = attempt.then(() => {}, () => {});
    return attempt;
  }
}

module.exports = { NativeHelperWorker, MAX_BUFFER_BYTES };
