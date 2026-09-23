'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');

// The certificate password is a signing credential, so it is never written in the clear and
// never placed in settings.json. Electron's safeStorage encrypts it with the OS keyring —
// DPAPI under the current Windows account on this machine — and only the ciphertext is stored.

const FILE_NAME = 'certificate-password.bin';
const MAX_LENGTH = 256;

class SecretStore {
  #directory;
  #safeStorage;
  #fs;

  constructor({ directory, safeStorage, fs = nodeFs }) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
    if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
      throw new TypeError('safeStorage is required');
    }
    this.#directory = directory;
    this.#safeStorage = safeStorage;
    this.#fs = fs;
  }

  get file() { return path.join(this.#directory, FILE_NAME); }

  available() {
    try { return this.#safeStorage.isEncryptionAvailable() === true; } catch { return false; }
  }

  has() {
    try { return this.#fs.existsSync(this.file); } catch { return false; }
  }

  save(plain) {
    if (typeof plain !== 'string' || plain.length === 0 || plain.length > MAX_LENGTH) {
      throw new Error('저장할 비밀번호가 올바르지 않습니다.');
    }
    if (!this.available()) throw new Error('이 컴퓨터에서는 비밀번호를 안전하게 저장할 수 없습니다.');
    const encrypted = this.#safeStorage.encryptString(plain);
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('비밀번호를 저장하지 못했습니다.');
    this.#fs.mkdirSync(this.#directory, { recursive: true });
    const target = this.file;
    this.#fs.writeFileSync(`${target}.tmp`, encrypted, { mode: 0o600 });
    this.#fs.renameSync(`${target}.tmp`, target);
    return true;
  }

  load() {
    if (!this.available()) return null;
    let encrypted;
    try { encrypted = this.#fs.readFileSync(this.file); } catch { return null; }
    if (!encrypted || encrypted.length === 0) return null;
    try {
      const plain = this.#safeStorage.decryptString(encrypted);
      // A credential from another account or machine cannot be decrypted; treat it as absent
      // rather than surfacing a raw error.
      return typeof plain === 'string' && plain.length > 0 && plain.length <= MAX_LENGTH ? plain : null;
    } catch { return null; }
  }

  clear() {
    try { this.#fs.rmSync(this.file, { force: true }); } catch { return false; }
    return true;
  }
}

module.exports = { SecretStore, FILE_NAME, MAX_LENGTH };
