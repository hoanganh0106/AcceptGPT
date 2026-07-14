export type DomainErrorCode = 'INVALID_CDK_COUNT' | 'CDK_GENERATION_FAILED' | 'CDK_HASH_COLLISION' | 'INVALID_INPUT' | 'CDK_INVALID_OR_USED' | 'SESSION_INVALID' | 'WORKSPACE_NOT_CONFIGURED' | 'SUPABASE_UNAVAILABLE' | 'JOIN_REJECTED' | 'ACCEPT_NOT_FOUND' | 'WORKER_UNAVAILABLE' | 'UPSTREAM_TIMEOUT' | 'INTERNAL_ERROR';
export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, readonly publicMessage = 'Không thể hoàn tất yêu cầu.', readonly safeCauseCode?: string) { super(code); this.name = 'DomainError'; }
}
