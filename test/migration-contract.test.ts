import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('Supabase migration contains atomic one-way CDK ownership', () => { const sql = readFileSync('supabase/migrations/202607140001_cdk_invite.sql', 'utf8').toLowerCase(); assert.match(sql, /create table public\.app_settings/); assert.match(sql, /invite_workspace_id uuid/); assert.match(sql, /create table public\.cdks/); assert.match(sql, /create or replace function public\.consume_cdk/); assert.match(sql, /where code_hash = p_code_hash\s+and status = 'unused'/); assert.match(sql, /enable row level security/); assert.doesNotMatch(sql, /plaintext|code_hint/); });
