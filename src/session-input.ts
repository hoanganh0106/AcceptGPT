import { DomainError } from './domain-error';
export interface SessionCredentials { accessToken: string; clear(): void; }
export interface SessionClaims { email: string; accountId: string; expiresAt: number; }
export class MutableSessionCredentials implements SessionCredentials { constructor(public accessToken: string) {} clear(): void { this.accessToken = ''; } }
const tokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export function parseSingleSession(input: unknown): SessionCredentials {
  if (typeof input === 'string') { const token = input.trim(); if (token.startsWith('{') || token.startsWith('[')) { let parsed: unknown; try { parsed = JSON.parse(token) as unknown; } catch { throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.'); } return parseSingleSession(parsed); } if (input.includes('\n') || input.includes('\r')) throw new DomainError('SESSION_INVALID', 'Chỉ được gửi một session.'); if (!token || !tokenPattern.test(token)) throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.'); return new MutableSessionCredentials(token); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.');
  const values = input as Record<string, unknown>;
  const token = ['accessToken', 'access_token', 'at'].map((key) => values[key]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (!token || !tokenPattern.test(token.trim())) throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.');
  return new MutableSessionCredentials(token.trim());
}
function decodeSegment(segment: string): unknown { try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown; } catch { throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.'); } }
export function decodeSessionClaims(accessToken: string, now = Math.floor(Date.now() / 1000)): SessionClaims {
  const parts = accessToken.split('.'); if (parts.length !== 3) throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.'); const payload = decodeSegment(parts[1]); if (!payload || typeof payload !== 'object') throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.'); const p = payload as Record<string, unknown>;
  const auth = p['https://api.openai.com/auth']; const profile = p['https://api.openai.com/profile']; const authObj = auth && typeof auth === 'object' ? auth as Record<string, unknown> : {}; const profileObj = profile && typeof profile === 'object' ? profile as Record<string, unknown> : {};
  const email = typeof profileObj.email === 'string' ? profileObj.email.toLowerCase() : typeof p.email === 'string' ? p.email.toLowerCase() : ''; const accountId = typeof authObj.chatgpt_account_id === 'string' ? authObj.chatgpt_account_id : typeof p.account_id === 'string' ? p.account_id : ''; const expiresAt = p.exp;
  if (!email || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) throw new DomainError('SESSION_INVALID', 'Session không hợp lệ hoặc đã hết hạn.');
  return { email, accountId, expiresAt };
}
