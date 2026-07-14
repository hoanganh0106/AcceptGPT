import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSessionClaims, parseSingleSession } from '../src/session-input';
const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' }, 'https://api.openai.com/profile': { email: 'User@Example.com' } })).toString('base64url')}.signature`;
test('accepts one raw or aliased session and clears it', () => { for (const value of [token, { accessToken: token }, { access_token: token }, { at: token }]) { const credentials = parseSingleSession(value); assert.equal(credentials.accessToken, token); credentials.clear(); assert.equal(credentials.accessToken, ''); } assert.equal(decodeSessionClaims(token).email, 'user@example.com'); });
test('rejects session batches', () => { assert.throws(() => parseSingleSession([token]), /Chỉ được gửi một session|SESSION_INVALID/); assert.throws(() => parseSingleSession(`${token}\n${token}`), /Chỉ được gửi một session|SESSION_INVALID/); });
