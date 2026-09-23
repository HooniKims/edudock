const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForUserAuthentication, AuthenticationCancelledError } = require('../src/auth.cjs');

test('official authentication wait completes only after authenticated state is observed', async () => {
  let checks = 0;
  const result = await waitForUserAuthentication({
    isAuthenticated: async () => ++checks === 3,
    isCancelled: () => false,
    pause: async () => {},
    timeoutMs: 1000,
    pollMs: 10,
  });
  assert.equal(result, true);
  assert.equal(checks, 3);
});

test('official authentication wait is cancelable without inferring failure or success', async () => {
  let cancelled = false;
  await assert.rejects(
    waitForUserAuthentication({
      isAuthenticated: async () => false,
      isCancelled: () => cancelled,
      pause: async () => { cancelled = true; },
      timeoutMs: 1000,
      pollMs: 10,
    }),
    AuthenticationCancelledError,
  );
});

test('cancellation that happens during an authentication observation wins the race', async () => {
  let cancelled = false;
  await assert.rejects(
    waitForUserAuthentication({
      isAuthenticated: async () => { cancelled = true; return true; },
      isCancelled: () => cancelled,
      pause: async () => {},
      timeoutMs: 1000,
      pollMs: 10,
    }),
    AuthenticationCancelledError,
  );
});
