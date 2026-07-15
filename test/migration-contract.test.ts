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
test('CDK plaintext migration keeps code immutable and service-role scoped', () => {
  const sql = readFileSync('supabase/migrations/202607150002_cdk_plaintext.sql', 'utf8').toLowerCase();
  assert.match(sql, /add column code_plain text/);
  assert.match(sql, /new\.code_plain is distinct from old\.code_plain/);
  assert.match(sql, /grant insert \(code_hash, code_plain\) on table public\.cdks to service_role/);
  assert.match(sql, /create index cdks_email_idx/);
});
