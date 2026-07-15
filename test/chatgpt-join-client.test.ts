import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptJoinClient } from '../src/chatgpt-join-client';
import { DomainError } from '../src/domain-error';

const credentials = { accessToken: 'token', clear() {} };
const claims = { email: 'user@example.com', accountId: '123e4567-e89b-42d3-a456-426614174000', expiresAt: 2_000_000_000 };
const options = { baseUrl: 'https://chatgpt.com', timeoutMs: 100, maxRetries: 1, retryBackoffMs: 0 };

test('validateSession trusts the JWT account ID when /me uses a user-prefixed ID', async () => {
  const client = new ChatGptJoinClient(options, async () => new Response(JSON.stringify({ id: 'user-abc', email: 'user@example.com' }), { status: 200 }));
  const actual = await client.validateSession(credentials, claims);
  assert.deepEqual(actual, { email: 'user@example.com', accountId: claims.accountId });
});

test('validateSession rejects a mismatched email and maps upstream failures', async () => {
  const mismatch = new ChatGptJoinClient(options, async () => new Response(JSON.stringify({ id: 'user-abc', email: 'other@example.com' }), { status: 200 }));
  await assert.rejects(() => mismatch.validateSession(credentials, claims), (error: unknown) => error instanceof DomainError && error.code === 'SESSION_INVALID');

  const unavailable = new ChatGptJoinClient(options, async () => new Response('', { status: 500 }));
  await assert.rejects(() => unavailable.validateSession(credentials, claims), (error: unknown) => error instanceof DomainError && error.code === 'UPSTREAM_TIMEOUT');
});
