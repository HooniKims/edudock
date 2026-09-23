'use strict';

const fs = require('node:fs');
const { shell } = require('electron');

const log = process.env.EDUDOCK_QA_OPEN_EXTERNAL_LOG;
if (!log) throw new Error('EDUDOCK_QA_OPEN_EXTERNAL_LOG is required.');
shell.openExternal = async url => {
  const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
  calls.push(String(url));
  fs.writeFileSync(log, JSON.stringify(calls, null, 2));
};
require('../src/main.cjs');
