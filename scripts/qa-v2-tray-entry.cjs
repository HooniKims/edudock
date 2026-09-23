'use strict';

const path = require('node:path');
const { app } = require('electron');

app.setAppPath(path.resolve(__dirname, '..'));
require('./qa-v2-tray-bootstrap.cjs');
require('../src/main.cjs');
