'use strict';

// A short, local record of what the widget did, kept so a teacher can send it when something
// does not work on their PC ("일반기안 눌렀는데 기안창이 안 떠요"). It holds button presses, the
// widget's own status lines and failure reason codes — never passwords, never draft text, and
// it is never sent anywhere by the app. Settings saves it as a text file on request.

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE = 'diagnostic-log.jsonl';
const KEEP = 400;
const TRIM_AT = 600;
const MAX_TEXT = 300;

function clip(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function createDiagnosticLog({ directory, fs = nodeFs, now = () => new Date() }) {
  const file = path.join(directory, FILE);
  let lines = null;

  function load() {
    if (lines) return lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
    return lines;
  }

  // Only plain, short fields are kept; anything else a caller passes is dropped.
  function append(event, fields = {}) {
    const entry = { at: now().toISOString(), event: clip(event) };
    for (const key of ['id', 'phase', 'message', 'detail', 'version']) {
      const value = clip(fields[key]);
      if (value !== undefined && value !== '') entry[key] = value;
    }
    const all = load();
    all.push(JSON.stringify(entry));
    try {
      if (all.length > TRIM_AT) {
        lines = all.slice(-KEEP);
        fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      } else {
        fs.appendFileSync(file, `${all[all.length - 1]}\n`, 'utf8');
      }
    } catch {}
    return entry;
  }

  function entries() {
    return load().map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }

  // A plain text report a teacher can attach to a message.
  function report({ appVersion, edition }) {
    const head = [
      '업무포털 도우미(EduDock) 문제 보고용 기록',
      `만든 시각: ${now().toISOString()}`,
      `앱 버전: ${appVersion} (${edition})`,
      `Windows: ${os.release()} ${os.arch()}`,
      '비밀번호와 초안 내용은 기록하지 않습니다.',
      '',
    ];
    const body = entries().map(entry => [entry.at, entry.event, entry.id, entry.phase, entry.message, entry.detail, entry.version].filter(Boolean).join(' | '));
    return `${[...head, ...body].join('\r\n')}\r\n`;
  }

  return { append, entries, report, file };
}

module.exports = { createDiagnosticLog, clip };
