import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSessionClaims, parseSingleSession } from '../src/session-input';
const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' }, 'https://api.openai.com/profile': { email: 'User@Example.com' } })).toString('base64url')}.signature`;
test('accepts one raw or aliased session and clears it', () => { for (const value of [token, { accessToken: token }, { access_token: token }, { at: token }]) { const credentials = parseSingleSession(value); assert.equal(credentials.accessToken, token); credentials.clear(); assert.equal(credentials.accessToken, ''); } assert.equal(decodeSessionClaims(token).email, 'user@example.com'); });
test('accepts one JSON session object pasted into the web textarea', () => {
  for (const alias of ['accessToken', 'access_token', 'at']) {
    const credentials = parseSingleSession(JSON.stringify({ [alias]: token }, null, 2));
    assert.equal(credentials.accessToken, token);
    credentials.clear();
    assert.equal(credentials.accessToken, '');
  }
});
test('rejects session batches', () => { assert.throws(() => parseSingleSession([token]), /Chỉ được gửi một session|SESSION_INVALID/); assert.throws(() => parseSingleSession(`${token}\n${token}`), /Chỉ được gửi một session|SESSION_INVALID/); });
test('accepts a full session JSON with extra keys, ignoring them', () => {
  const full = { type: 'codex', user: { id: 'x' }, expires: '2099-01-01', account_id: 'account-1', email: 'User@Example.com', id_token: 'eyJ.a.b', refresh_token: 'rt', session_token: 'st', access_token: token, authProvider: 'auth0' };
  for (const value of [full, JSON.stringify(full, null, 2)]) {
    const credentials = parseSingleSession(value);
    assert.equal(credentials.accessToken, token);
  }
});
test('decodes claims even when the JWT has no account_id', () => {
  const noAccount = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60, 'https://api.openai.com/profile': { email: 'User@Example.com' } })).toString('base64url')}.signature`;
  const claims = decodeSessionClaims(noAccount);
  assert.equal(claims.email, 'user@example.com');
  assert.equal(claims.accountId, '');
});
