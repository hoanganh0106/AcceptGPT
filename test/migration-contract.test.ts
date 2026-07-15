import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('Supabase migration contains atomic one-way CDK ownership', () => { const sql = readFileSync('supabase/migrations/202607140001_cdk_invite.sql', 'utf8').toLowerCase(); assert.match(sql, /create table public\.app_settings/); assert.match(sql, /invite_workspace_id uuid/); assert.match(sql, /create table public\.cdks/); assert.match(sql, /create or replace function public\.consume_cdk/); assert.match(sql, /where code_hash = p_code_hash\s+and status = 'unused'/); assert.match(sql, /enable row level security/); assert.doesNotMatch(sql, /plaintext|code_hint/); });
test('CDK deletion migration permits only unused and failed CDKs through an RPC guard', () => {
  const sql = readFileSync('supabase/migrations/202607150001_cdk_delete.sql', 'utf8').toLowerCase();
  assert.match(sql, /create or replace function public\.delete_removable_cdks\(p_ids uuid\[\] default null\)/);
  assert.match(sql, /security definer/);
  assert.match(sql, /c\.status = 'unused'/);
  assert.match(sql, /'join_rejected','accept_not_found','worker_unavailable','upstream_timeout','internal_error','service_interrupted'/);
  assert.match(sql, /grant execute on function public\.delete_removable_cdks\(uuid\[\]\) to service_role/);
  assert.doesNotMatch(sql, /grant delete on table public\.cdks/);
});
