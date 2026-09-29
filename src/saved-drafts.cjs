'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Drafts the teacher chose to keep ("목록에 저장"), stored on this PC only, newest first. A
// saved draft can be picked later and put into a new 기안창 like a freshly generated one.

const FILE_NAME = 'saved-drafts.json';
const MAX_ITEMS = 100;
const MAX_TITLE = 200;
const MAX_BODY = 20000;

function clean(item) {
  if (!item || typeof item !== 'object') return null;
  const title = typeof item.title === 'string' ? item.title.trim().slice(0, MAX_TITLE) : '';
  const body = typeof item.body === 'string' ? item.body.slice(0, MAX_BODY) : '';
  if (!title || !body.trim()) return null;
  return {
    id: typeof item.id === 'string' && /^[a-f0-9-]{8,64}$/.test(item.id) ? item.id : crypto.randomUUID(),
    title,
    body,
    savedAt: typeof item.savedAt === 'string' && !Number.isNaN(Date.parse(item.savedAt)) ? item.savedAt : new Date().toISOString(),
  };
}

function createSavedDrafts({ directory, fs = nodeFs, now = () => new Date() }) {
  const file = path.join(directory, FILE_NAME);

  function list() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (Array.isArray(parsed) ? parsed : []).map(clean).filter(Boolean).slice(0, MAX_ITEMS);
    } catch { return []; }
  }

  function write(items) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    return items;
  }

  // Saving the same title again replaces that entry, so re-saving an edited draft does not pile
  // up copies.
  function save(draft) {
    const item = clean({ ...draft, id: undefined, savedAt: now().toISOString() });
    if (!item) throw new Error('제목과 초안 내용이 있어야 저장할 수 있어요.');
    const rest = list().filter(existing => existing.title !== item.title);
    return write([item, ...rest].slice(0, MAX_ITEMS));
  }

  function remove(id) {
    return write(list().filter(item => item.id !== id));
  }

  return { list, save, remove, get file() { return file; } };
}

module.exports = { createSavedDrafts, MAX_ITEMS };
