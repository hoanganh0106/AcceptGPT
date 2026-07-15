import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptJoinClient } from '../src/chatgpt-join-client';

const credentials = { accessToken: 'token', clear() {} };
const claims = { email: 'user@example.com', accountId: '123e4567-e89b-42d3-a456-426614174000', expiresAt: 2_000_000_000 };
const options = { baseUrl: 'https://chatgpt.com', timeoutMs: 100, maxRetries: 1, retryBackoffMs: 0 };

test('requestJoin does not require the blocked /me endpoint before joining', async () => {
  const paths: string[] = [];
  const client = new ChatGptJoinClient(options, async (input) => {
    paths.push(String(input));
    if (String(input).endsWith('/invites/request')) return new Response('', { status: 200 });
    if (String(input).endsWith('/invites/accept')) return new Response('', { status: 200 });
    return new Response(JSON.stringify({ accounts: ['workspace-1'] }), { status: 200 });
  });
  const actual = await client.requestJoin(credentials, 'workspace-1');
  assert.equal(actual.membership, 'member');
  assert.deepEqual(paths, [
    'https://chatgpt.com/backend-api/accounts/workspace-1/invites/request',
    'https://chatgpt.com/backend-api/accounts/workspace-1/invites/accept',
    'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27',
  ]);
});
