import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseCdkStore } from '../src/supabase-store';

test('CDK history formats plaintext and forwards email/code search', async () => {
  const calls: string[] = [];
  const row = { id: 'cdk-1', status: 'used', code_plain: 'ABCDEFGHJKLMNPQR', email: 'user@example.com', workspace_id: 'workspace-1', result: 'accepted', created_at: '2026-07-15T00:00:00Z', used_at: '2026-07-15T00:01:00Z' };
  const chain = {
    select() { return this; }, order() { return this; }, or(value: string) { calls.push(value); return this; },
    range: async () => ({ data: [row], count: 1, error: null }),
  };
  const store = new SupabaseCdkStore({ from: () => chain } as never);
  const page = await store.listCdkHistory(50, 0, 'ABCD-EFGH');
  assert.deepEqual(page.records[0], { id: 'cdk-1', status: 'used', code: 'ABCD-EFGH-JKLM-NPQR', email: 'user@example.com', workspaceId: 'workspace-1', result: 'accepted', createdAt: row.created_at, usedAt: row.used_at });
  assert.deepEqual(calls, ['email.ilike.%ABCDEFGH%,code_plain.ilike.%ABCDEFGH%']);
});
