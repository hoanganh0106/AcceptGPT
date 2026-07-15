import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server';
import { AdminAuth } from '../src/admin-auth';
import { JobQueue } from '../src/queue';
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never;
test('server preserves webhook contract and adds no-store pages', async () => { const queue = new JobQueue(); const auth = await AdminAuth.create({ password: 'password', sessionSecret: 's'.repeat(32), ttlMs: 1000, publicOrigin: 'https://accept.example.com' }); const app = buildServer({ host: '127.0.0.1', port: 8080, webhookPath: '/webhook', webhookSecret: 'test-secret', publicOrigin: 'https://accept.example.com', adminSessionSecret: 's'.repeat(32), redeemRateLimitMax: 10, loginRateLimitMax: 5, rateLimitWindowMs: 60000 }, logger, { queue, worker: { isReadyForRedemptions: true } as never, redemptions: { redeem: async () => ({ ok: false, code: 'INVALID_INPUT', message: 'invalid' }) } as never, cdkStore: { getInviteWorkspaceId: async () => null, setInviteWorkspaceId: async () => {}, hasUnusedCdk: async () => false, insertCdkHashes: async () => {}, claimCdk: async () => null, finishCdk: async () => false, markInterrupted: async () => 0, listCdkHistory: async () => ({ records: [], total: 0 }) }, cdkIssuer: { issue: async () => [] } as never, adminAuth: auth }); const page = await app.inject({ method: 'GET', url: '/' }); assert.equal(page.statusCode, 200); assert.equal(page.headers['cache-control'], 'no-store'); const response = await app.inject({ method: 'POST', url: '/webhook', headers: { 'x-webhook-secret': 'test-secret' }, payload: { emails: [' User@Example.com ', 'user@example.com'] } }); assert.equal(response.statusCode, 202); assert.equal(response.json().count, 1); await app.close(); });
test('rate limits return Vietnamese JSON feedback', async () => {
  const queue = new JobQueue();
  const auth = await AdminAuth.create({ password: 'password', sessionSecret: 's'.repeat(32), ttlMs: 1000, publicOrigin: 'https://accept.example.com' });
  const app = buildServer({ host: '127.0.0.1', port: 8080, webhookPath: '/webhook', webhookSecret: null, publicOrigin: 'https://accept.example.com', adminSessionSecret: 's'.repeat(32), redeemRateLimitMax: 1, loginRateLimitMax: 1, rateLimitWindowMs: 60000 }, logger, { queue, worker: { isReadyForRedemptions: true } as never, redemptions: { redeem: async () => ({ ok: false, code: 'INVALID_INPUT', message: 'invalid' }) } as never, cdkStore: { getInviteWorkspaceId: async () => null, setInviteWorkspaceId: async () => {}, hasUnusedCdk: async () => false, insertCdkHashes: async () => {}, claimCdk: async () => null, finishCdk: async () => false, markInterrupted: async () => 0, listCdkHistory: async () => ({ records: [], total: 0 }) }, cdkIssuer: { issue: async () => [] } as never, adminAuth: auth });
  await app.inject({ method: 'POST', url: '/api/redeem', payload: { cdk: 'A', session: 'B' } });
  const limited = await app.inject({ method: 'POST', url: '/api/redeem', payload: { cdk: 'A', session: 'B' } });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.deepEqual(limited.json(), { code: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.' });
  await app.close();
});
