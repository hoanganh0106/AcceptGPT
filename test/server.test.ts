import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server';
import { AdminAuth } from '../src/admin-auth';
import { JobQueue } from '../src/queue';

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never;
const config = { host: '127.0.0.1', port: 8080, webhookPath: '/webhook', webhookSecret: null, publicOrigin: 'https://accept.example.com', adminSessionSecret: 's'.repeat(32), redeemRateLimitMax: 10, loginRateLimitMax: 5, rateLimitWindowMs: 60000 };
async function appFor(overrides: { deleted?: number; redeemRateLimitMax?: number } = {}) {
  const auth = await AdminAuth.create({ password: 'password', sessionSecret: 's'.repeat(32), ttlMs: 1000, publicOrigin: config.publicOrigin });
  const app = buildServer({ ...config, redeemRateLimitMax: overrides.redeemRateLimitMax ?? config.redeemRateLimitMax }, logger, {
    queue: new JobQueue(), worker: { isReadyForRedemptions: true } as never,
    redemptions: { redeem: async () => ({ ok: false, code: 'INVALID_INPUT', message: 'invalid' }) } as never,
    cdkStore: { getInviteWorkspaceId: async () => null, setInviteWorkspaceId: async () => {}, hasUnusedCdk: async () => false, insertCdkHashes: async () => {}, claimCdk: async () => null, finishCdk: async () => false, markInterrupted: async () => 0, listCdkHistory: async () => ({ records: [], total: 0 }), deleteRemovableCdks: async () => overrides.deleted ?? 2 },
    cdkIssuer: { issue: async () => [] } as never, adminAuth: auth,
  });
  return app;
}

test('server preserves webhook contract and adds no-store pages', async () => {
  const app = await appFor();
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200); assert.equal(page.headers['cache-control'], 'no-store');
  const response = await app.inject({ method: 'POST', url: '/webhook', payload: { emails: [' User@Example.com ', 'user@example.com'] } });
  assert.equal(response.statusCode, 202); assert.equal(response.json().count, 1); await app.close();
});

test('rate limits return Vietnamese JSON feedback', async () => {
  const app = await appFor({ redeemRateLimitMax: 1 });
  await app.inject({ method: 'POST', url: '/api/redeem', payload: { cdk: 'A', session: 'B' } });
  const limited = await app.inject({ method: 'POST', url: '/api/redeem', payload: { cdk: 'A', session: 'B' } });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.deepEqual(limited.json(), { code: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.' }); await app.close();
});

test('admin delete route requires CSRF and only accepts a bounded UUID list or all', async () => {
  const app = await appFor({ deleted: 3 });
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'password' } });
  const cookie = login.headers['set-cookie'];
  assert.equal(login.statusCode, 200);
  const state = await app.inject({ method: 'GET', url: '/api/admin/state', headers: { cookie } });
  const csrfToken = state.json().csrfToken as string;
  const rejected = await app.inject({ method: 'POST', url: '/api/admin/cdks/delete', headers: { cookie }, payload: { all: true } });
  assert.equal(rejected.statusCode, 403);
  const deleted = await app.inject({ method: 'POST', url: '/api/admin/cdks/delete', headers: { cookie, origin: config.publicOrigin, 'x-csrf-token': csrfToken }, payload: { ids: ['123e4567-e89b-42d3-a456-426614174000'] } });
  assert.equal(deleted.statusCode, 200, deleted.body); assert.deepEqual(deleted.json(), { deleted: 3 });
  const invalid = await app.inject({ method: 'POST', url: '/api/admin/cdks/delete', headers: { cookie, origin: config.publicOrigin, 'x-csrf-token': csrfToken }, payload: { ids: ['invalid'] } });
  assert.equal(invalid.statusCode, 400); await app.close();
});
