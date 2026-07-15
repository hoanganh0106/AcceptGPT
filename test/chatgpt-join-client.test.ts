import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptJoinClient } from '../src/chatgpt-join-client';

const credentials = { accessToken: 'token', clear() {} };
const claims = { email: 'user@example.com', accountId: '123e4567-e89b-42d3-a456-426614174000', expiresAt: 2_000_000_000 };
const options = { baseUrl: 'https://chatgpt.com', timeoutMs: 100, maxRetries: 1, retryBackoffMs: 0 };

test('requestJoin does not require the blocked /me endpoint before joining', async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const client = new ChatGptJoinClient(options, async (input, init) => {
    requests.push({ input: String(input), init });
    if (String(input).endsWith('/invites/request')) return new Response('', { status: 200 });
    if (String(input).endsWith('/invites/accept')) return new Response('', { status: 200 });
    return new Response(JSON.stringify({ accounts: ['workspace-1'] }), { status: 200 });
  }, undefined, () => 'device-1');
  const actual = await client.requestJoin(credentials, 'workspace-1');
  assert.equal(actual.membership, 'member');
  assert.deepEqual(requests.map(({ input }) => input), [
    'https://chatgpt.com/backend-api/accounts/workspace-1/invites/request',
    'https://chatgpt.com/backend-api/accounts/workspace-1/invites/accept',
    'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27',
  ]);
  assert.deepEqual(requests.map(({ init }) => new Headers(init?.headers).get('oai-device-id')), ['device-1', 'device-1', 'device-1']);
  for (const { init } of requests) {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('user-agent'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    assert.equal(headers.get('accept-language'), 'en-US,en;q=0.9');
    assert.equal(headers.get('origin'), 'https://chatgpt.com');
    assert.equal(headers.get('referer'), 'https://chatgpt.com/');
    assert.equal(headers.get('sec-ch-ua'), '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
    assert.equal(headers.get('sec-ch-ua-mobile'), '?0');
    assert.equal(headers.get('sec-ch-ua-platform'), '"Windows"');
    assert.equal(headers.get('sec-fetch-dest'), 'empty');
    assert.equal(headers.get('sec-fetch-mode'), 'cors');
    assert.equal(headers.get('sec-fetch-site'), 'same-origin');
  }
  assert.equal(requests[0].init?.body, '');
  assert.equal(requests[1].init?.body, '');
  assert.equal(requests[2].init?.body, undefined);
});

test('logs non-2xx status and keeps the upstream reason out of secrets', async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const client = new ChatGptJoinClient(options, async (input) => {
      if (String(input).includes('/invites/')) return new Response('', { status: 403 });
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    });
    await assert.rejects(
      () => client.requestJoin({ accessToken: 'secret-token', clear() {} }, 'workspace-1'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'JOIN_REJECTED');
        assert.match(String((error as { safeCauseCode?: string }).safeCauseCode), /403/);
        assert.match(String((error as { safeCauseCode?: string }).safeCauseCode), /seat_or_blocked/);
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(warnings), /secret-token/);
});
