const fs = require('node:fs');

function parseCredentials(text) {
  const result = { username: '', password: '', certificatePassword: '' };
  const aliases = {
    id: 'username', username: 'username', portal_id: 'username', neis_id: 'username', 아이디: 'username',
    pw: 'password', password: 'password', portal_password: 'password', 비번: 'password', 비밀번호: 'password',
    cert_password: 'certificatePassword', certificate_password: 'certificatePassword', 인증서비밀번호: 'certificatePassword',
  };
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([^=:\s]+)\s*[=:：]\s*(.*?)\s*$/);
    if (!match || !aliases[match[1].toLowerCase()]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[aliases[match[1].toLowerCase()]] = value;
  }
  return result;
}

function readCredentials(file) {
  if (!file || !fs.existsSync(file)) return { username: '', password: '', certificatePassword: '' };
  if (fs.statSync(file).size > 16384) throw new Error('로그인 설정 파일이 너무 큽니다.');
  return parseCredentials(fs.readFileSync(file, 'utf8'));
}
module.exports = { parseCredentials, readCredentials };
