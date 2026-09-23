'use strict';

class AuthenticationCancelledError extends Error {
  constructor() {
    super('로그인 대기를 취소했습니다.');
    this.name = 'AuthenticationCancelledError';
  }
}

class AuthenticationTimeoutError extends Error {
  constructor() {
    super('인증 대기 시간이 끝났습니다. Edge에서 인증을 다시 시작해 주세요.');
    this.name = 'AuthenticationTimeoutError';
  }
}

class ConnectionTimeoutError extends Error {
  constructor() {
    super('업무포털 연결 시간이 끝났습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.');
    this.name = 'ConnectionTimeoutError';
  }
}

async function waitForUserAuthentication({ isAuthenticated, isCancelled, pause, timeoutMs = 300000, pollMs = 250 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isCancelled()) throw new AuthenticationCancelledError();
    const authenticated = await isAuthenticated();
    if (isCancelled()) throw new AuthenticationCancelledError();
    if (authenticated) return true;
    await pause(pollMs);
  }
  if (isCancelled()) throw new AuthenticationCancelledError();
  throw new AuthenticationTimeoutError();
}

module.exports = { waitForUserAuthentication, AuthenticationCancelledError, AuthenticationTimeoutError, ConnectionTimeoutError };
