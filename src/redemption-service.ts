import type { Logger } from './logger';
import { normalizeCdk, hashCdk } from './cdk';
import { DomainError, type DomainErrorCode } from './domain-error';
import { parseSingleSession, decodeSessionClaims, type SessionCredentials } from './session-input';
import type { JoinClient } from './chatgpt-join-client';
import { createAwaitableJob, type JobQueue, type JobCompletion } from './queue';
import type { ClaimedCdk, CdkStore, TerminalCdkResult } from './supabase-store';

export type RedemptionErrorCode = DomainErrorCode;
export type RedemptionResult = { ok: true; status: 'accepted' | 'already_member'; email: string } | { ok: false; code: RedemptionErrorCode; message: string };
export type RedemptionProgress = { step: 'cdk_valid' | 'session_loaded' | 'join_request' | 'queued' | 'approved'; email?: string };
type ProgressCallback = (event: RedemptionProgress) => void;
interface RedemptionWorker { isReadyForRedemptions: boolean; }
export interface RedemptionOptions { store: CdkStore; queue: JobQueue; worker: RedemptionWorker; joinClient: JoinClient; cdkHashSecret: string; logger: Logger; }
const RESULT_BY_ERROR: Partial<Record<DomainErrorCode, TerminalCdkResult>> = { JOIN_REJECTED: 'join_rejected', ACCEPT_NOT_FOUND: 'accept_not_found', WORKER_UNAVAILABLE: 'worker_unavailable', UPSTREAM_TIMEOUT: 'upstream_timeout', INTERNAL_ERROR: 'internal_error', SUPABASE_UNAVAILABLE: 'internal_error' };
const toSafe = (error: unknown): DomainError => error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', 'Không thể hoàn tất yêu cầu.');
const reportProgress = (callback: ProgressCallback | undefined, event: RedemptionProgress): void => { try { callback?.(event); } catch { /* A disconnected stream must not change redemption state. */ } };

export class RedemptionService {
  constructor(private readonly options: RedemptionOptions) {}

  async redeem(input: { cdk: unknown; session: unknown }, onProgress?: ProgressCallback): Promise<RedemptionResult> {
    let credentials: SessionCredentials | null = null;
    let claimed: ClaimedCdk | null = null;
    try {
      const workspaceId = await this.requireWorkspaceSnapshot();
      const normalized = this.requireNormalizedCdk(input.cdk);
      const codeHash = hashCdk(normalized, this.options.cdkHashSecret);
      await this.requirePossiblyUnused(codeHash);
      reportProgress(onProgress, { step: 'cdk_valid' });

      credentials = parseSingleSession(input.session);
      const claims = decodeSessionClaims(credentials.accessToken);
      reportProgress(onProgress, { step: 'session_loaded', email: claims.email });
      reportProgress(onProgress, { step: 'join_request' });
      const join = await this.options.joinClient.requestJoin(credentials, workspaceId);
      if (join.membership === 'member') {
        claimed = await this.claim(codeHash, claims.email, workspaceId);
        return await this.finishSuccess(claimed, 'already_member', claims.email);
      }
      if (!this.options.worker.isReadyForRedemptions) throw new DomainError('WORKER_UNAVAILABLE', 'Hệ thống duyệt hiện chưa sẵn sàng.');

      const ticket = createAwaitableJob([claims.email]);
      this.options.queue.enqueue(ticket.job);
      reportProgress(onProgress, { step: 'queued' });
      const completion = await ticket.completion;
      this.assertAccepted(claims.email, completion);
      reportProgress(onProgress, { step: 'approved' });
      claimed = await this.claim(codeHash, claims.email, workspaceId);
      return await this.finishSuccess(claimed, 'accepted', claims.email);
    } catch (error) {
      return await this.failSafely(claimed, error);
    } finally {
      credentials?.clear();
      credentials = null;
    }
  }

  private async claim(codeHash: string, email: string, workspaceId: string): Promise<ClaimedCdk> { const claimed = await this.options.store.claimCdk({ codeHash, email, workspaceId }); if (!claimed) throw new DomainError('CDK_INVALID_OR_USED', 'CDK không hợp lệ hoặc đã được sử dụng.'); return claimed; }
  private async requireWorkspaceSnapshot(): Promise<string> { const workspace = await this.options.store.getInviteWorkspaceId(); if (!workspace) throw new DomainError('WORKSPACE_NOT_CONFIGURED', 'Quản trị viên chưa cấu hình workspace.'); return workspace; }
  private requireNormalizedCdk(value: unknown): string { if (typeof value !== 'string') throw new DomainError('INVALID_INPUT', 'Dữ liệu không hợp lệ.'); try { return normalizeCdk(value); } catch { throw new DomainError('CDK_INVALID_OR_USED', 'CDK không hợp lệ hoặc đã được sử dụng.'); } }
  private async requirePossiblyUnused(codeHash: string): Promise<void> { if (!(await this.options.store.hasUnusedCdk(codeHash))) throw new DomainError('CDK_INVALID_OR_USED', 'CDK không hợp lệ hoặc đã được sử dụng.'); }
  private assertAccepted(email: string, completion: JobCompletion): void { if (completion.kind === 'session-expired') throw new DomainError('WORKER_UNAVAILABLE', 'Hệ thống duyệt hiện chưa sẵn sàng.'); if (completion.kind === 'error') throw new DomainError(completion.code === 'worker-stopped' ? 'WORKER_UNAVAILABLE' : 'INTERNAL_ERROR', 'Không thể hoàn tất yêu cầu.'); const result = completion.results.find((item) => item.email === email); if (!result || result.status !== 'accepted') throw new DomainError('ACCEPT_NOT_FOUND', 'Không tìm thấy yêu cầu để duyệt.'); }
  private async finishSuccess(claimed: ClaimedCdk, status: 'accepted' | 'already_member', email: string): Promise<RedemptionResult> { await this.options.store.finishCdk(claimed.id, status); return { ok: true, status, email }; }
  private async failSafely(claimed: ClaimedCdk | null, error: unknown): Promise<RedemptionResult> { const safe = toSafe(error); if (claimed) { const result = RESULT_BY_ERROR[safe.code] ?? 'internal_error'; await this.options.store.finishCdk(claimed.id, result).catch((finishError) => this.options.logger.error('Không ghi được kết quả CDK đã dùng', { cdkId: claimed.id, code: safe.code, err: finishError })); } return { ok: false, code: safe.code, message: safe.publicMessage }; }
}
