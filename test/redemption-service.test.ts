import test from 'node:test';
import assert from 'node:assert/strict';
import { RedemptionService } from '../src/redemption-service';
import { DomainError } from '../src/domain-error';

const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60, email: 'user@example.com' })).toString('base64url')}.signature`;
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never;
const baseStore = () => ({
  getInviteWorkspaceId: async () => 'workspace-1', hasUnusedCdk: async () => true,
  claimCdk: async () => ({ id: 'cdk-1', email: 'user@example.com', workspaceId: 'workspace-1', usedAt: new Date().toISOString(), result: 'processing' as const }),
  finishCdk: async () => true,
});

test('keeps CDK unused when join rejects before it is claimed', async () => {
  const store = { ...baseStore(), claimCdk: async () => { throw new Error('must not claim'); } };
  const service = new RedemptionService({
    store: store as never, queue: {} as never, worker: { isReadyForRedemptions: true }, cdkHashSecret: 's'.repeat(32), logger,
    joinClient: { requestJoin: async () => { throw new DomainError('JOIN_REJECTED'); } } as never,
  });
  const result = await service.redeem({ cdk: 'ABCD-EFGH-JKLM-NPQR', session: { access_token: token } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'JOIN_REJECTED');
});

test('claims and finishes CDK only after already-member join succeeds', async () => {
  const calls: string[] = [];
  const store = { ...baseStore(), claimCdk: async () => { calls.push('claim'); return baseStore().claimCdk(); }, finishCdk: async (_id: string, result: string) => { calls.push(`finish:${result}`); return true; } };
  const service = new RedemptionService({
    store: store as never, queue: {} as never, worker: { isReadyForRedemptions: true }, cdkHashSecret: 's'.repeat(32), logger,
    joinClient: { requestJoin: async () => { calls.push('join'); return { membership: 'member', requestAccepted: true, inviteAccepted: true }; } } as never,
  });
  const result = await service.redeem({ cdk: 'ABCD-EFGH-JKLM-NPQR', session: { access_token: token } });
  assert.deepEqual(calls, ['join', 'claim', 'finish:already_member']);
  assert.deepEqual(result, { ok: true, status: 'already_member', email: 'user@example.com' });
});

test('emits redemption progress in order for an accepted join', async () => {
  const steps: unknown[] = [];
  const service = new RedemptionService({
    store: baseStore() as never, queue: { enqueue: (job: { complete?: (completion: unknown) => void }) => queueMicrotask(() => job.complete?.({ kind: 'processed', results: [{ email: 'user@example.com', status: 'accepted' }], count: 1 })) } as never,
    worker: { isReadyForRedemptions: true }, cdkHashSecret: 's'.repeat(32), logger,
    joinClient: { requestJoin: async () => ({ membership: 'not-member', requestAccepted: true, inviteAccepted: true }) } as never,
  });
  const result = await service.redeem({ cdk: 'ABCD-EFGH-JKLM-NPQR', session: { access_token: token } }, (event) => steps.push(event));
  assert.equal(result.ok, true);
  assert.deepEqual(steps, [
    { step: 'cdk_valid' },
    { step: 'session_loaded', email: 'user@example.com' },
    { step: 'join_request' },
    { step: 'queued' },
    { step: 'approved' },
  ]);
});

test('stops redemption progress after join_request for an existing member', async () => {
  const steps: unknown[] = [];
  const service = new RedemptionService({
    store: baseStore() as never, queue: {} as never, worker: { isReadyForRedemptions: true }, cdkHashSecret: 's'.repeat(32), logger,
    joinClient: { requestJoin: async () => ({ membership: 'member', requestAccepted: true, inviteAccepted: true }) } as never,
  });
  const result = await service.redeem({ cdk: 'ABCD-EFGH-JKLM-NPQR', session: { access_token: token } }, (event) => steps.push(event));
  assert.equal(result.ok, true);
  assert.deepEqual(steps, [
    { step: 'cdk_valid' },
    { step: 'session_loaded', email: 'user@example.com' },
    { step: 'join_request' },
  ]);
});

test('does not emit server progress after an invalid CDK', async () => {
  const steps: unknown[] = [];
  const service = new RedemptionService({
    store: baseStore() as never, queue: {} as never, worker: { isReadyForRedemptions: true }, cdkHashSecret: 's'.repeat(32), logger,
    joinClient: {} as never,
  });
  const result = await service.redeem({ cdk: 'bad', session: { access_token: token } }, (event) => steps.push(event));
  assert.deepEqual(result, { ok: false, code: 'CDK_INVALID_OR_USED', message: 'CDK không hợp lệ hoặc đã được sử dụng.' });
  assert.deepEqual(steps, []);
});

test('progress callback failures do not fail the redemption', async () => {
  const service = new RedemptionService({
    store: baseStore() as never, queue: {} as never, worker: { isReadyForRedemptions: true }, cdkHashSecret: 's'.repeat(32), logger,
    joinClient: { requestJoin: async () => ({ membership: 'member', requestAccepted: true, inviteAccepted: true }) } as never,
  });
  const result = await service.redeem({ cdk: 'ABCD-EFGH-JKLM-NPQR', session: { access_token: token } }, () => { throw new Error('client disconnected'); });
  assert.deepEqual(result, { ok: true, status: 'already_member', email: 'user@example.com' });
});
