import type { AppSupabaseClient } from './supabase-client';
import type { CdkResult, CdkStatus } from './supabase-types';
import { DomainError } from './domain-error';

export type TerminalCdkResult = Exclude<CdkResult, 'processing'>;
export interface ClaimedCdk { id: string; email: string; workspaceId: string; usedAt: string; result: 'processing'; }
export interface CdkHistoryRecord { id: string; status: CdkStatus; email: string | null; workspaceId: string | null; result: CdkResult | null; createdAt: string; usedAt: string | null; }
export interface CdkHistoryPage { records: CdkHistoryRecord[]; total: number; }
export interface ClaimCdkInput { codeHash: string; email: string; workspaceId: string; }
export interface CdkStore {
  getInviteWorkspaceId(): Promise<string | null>; setInviteWorkspaceId(workspaceId: string): Promise<void>; hasUnusedCdk(codeHash: string): Promise<boolean>; insertCdkHashes(codeHashes: string[]): Promise<void>; claimCdk(input: ClaimCdkInput): Promise<ClaimedCdk | null>; finishCdk(id: string, result: TerminalCdkResult): Promise<boolean>; markInterrupted(): Promise<number>; listCdkHistory(limit: number, offset: number): Promise<CdkHistoryPage>; deleteRemovableCdks(ids: string[] | null): Promise<number>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isResult = (v: unknown): v is CdkResult => typeof v === 'string' && ['processing','accepted','already_member','join_rejected','accept_not_found','worker_unavailable','upstream_timeout','internal_error','service_interrupted'].includes(v);
const safeError = (operation: string, error: unknown): DomainError => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return new DomainError(code === '23505' ? 'CDK_HASH_COLLISION' : 'SUPABASE_UNAVAILABLE', 'Dịch vụ lưu trữ tạm thời không khả dụng.', `${operation}:${typeof code === 'string' ? code : 'unknown'}`);
};
function claimed(row: unknown): ClaimedCdk {
  if (!row || typeof row !== 'object') throw new DomainError('SUPABASE_UNAVAILABLE'); const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.email !== 'string' || typeof r.workspace_id !== 'string' || typeof r.used_at !== 'string' || r.result !== 'processing') throw new DomainError('SUPABASE_UNAVAILABLE');
  return { id: r.id, email: r.email, workspaceId: r.workspace_id, usedAt: r.used_at, result: 'processing' };
}
export class SupabaseCdkStore implements CdkStore {
  constructor(private readonly client: AppSupabaseClient) {}
  async getInviteWorkspaceId(): Promise<string | null> { const { data, error } = await this.client.from('app_settings').select('invite_workspace_id').eq('id', 1).single(); if (error) throw safeError('settings_read', error); return data.invite_workspace_id; }
  async setInviteWorkspaceId(workspaceId: string): Promise<void> { const { error } = await this.client.from('app_settings').update({ invite_workspace_id: workspaceId, updated_at: new Date().toISOString() }).eq('id', 1); if (error) throw safeError('settings_update', error); }
  async hasUnusedCdk(codeHash: string): Promise<boolean> { const { data, error } = await this.client.from('cdks').select('id').eq('code_hash', codeHash).eq('status', 'unused').maybeSingle(); if (error) throw safeError('cdk_inspect', error); return Boolean(data); }
  async insertCdkHashes(codeHashes: string[]): Promise<void> { const { error } = await this.client.from('cdks').insert(codeHashes.map((code_hash) => ({ code_hash }))); if (error) throw safeError('cdk_insert', error); }
  async claimCdk(input: ClaimCdkInput): Promise<ClaimedCdk | null> { const { data, error } = await this.client.rpc('consume_cdk', { p_code_hash: input.codeHash, p_email: input.email, p_workspace_id: input.workspaceId }); if (error) throw safeError('consume_cdk', error); return data?.length ? claimed(data[0]) : null; }
  async finishCdk(id: string, result: TerminalCdkResult): Promise<boolean> { const { data, error } = await this.client.from('cdks').update({ result }).eq('id', id).eq('status', 'used').eq('result', 'processing').select('id'); if (error) throw safeError('finish_cdk', error); return data.length === 1; }
  async markInterrupted(): Promise<number> { const { data, error } = await this.client.from('cdks').update({ result: 'service_interrupted' }).eq('status', 'used').eq('result', 'processing').select('id'); if (error) throw safeError('mark_interrupted', error); return data.length; }
  async listCdkHistory(limit: number, offset: number): Promise<CdkHistoryPage> {
    const { data, error, count } = await this.client.from('cdks').select('id,status,email,workspace_id,result,created_at,used_at', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + Math.max(0, limit) - 1);
    if (error) throw safeError('history_read', error);
    const records: CdkHistoryRecord[] = (data ?? []).map((row) => ({ id: row.id, status: row.status, email: row.email, workspaceId: row.workspace_id, result: isResult(row.result) ? row.result : null, createdAt: row.created_at, usedAt: row.used_at }));
    return { records, total: count ?? records.length };
  }
  async deleteRemovableCdks(ids: string[] | null): Promise<number> { const { data, error } = await this.client.rpc('delete_removable_cdks', { p_ids: ids }); if (error) throw safeError('delete_cdks', error); return typeof data === 'number' ? data : 0; }
}
export { UUID };
