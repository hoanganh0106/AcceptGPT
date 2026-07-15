import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const ADMIN_COOKIE_NAME = '__Host-acceptgpt_admin';
export const ADMIN_COOKIE_OPTIONS = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' as const, signed: true };
export interface AdminSession { cookieValue: string; csrfToken: string; expiresAt: number; }
export interface AdminAuthOptions { password: string; sessionSecret: string; ttlMs: number; publicOrigin: string; now?: () => number; random?: (size: number) => Buffer; }
interface SessionPayload { v: 1; csrf: string; exp: number; }
const encodePayload = (payload: SessionPayload): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const decodePayload = (value: string): SessionPayload | null => { try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SessionPayload>; if (parsed.v !== 1 || typeof parsed.csrf !== 'string' || !parsed.csrf || typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) return null; return { v: 1, csrf: parsed.csrf, exp: parsed.exp }; } catch { return null; } };
export class AdminAuth {
  private constructor(private readonly verifier: Buffer, private readonly options: AdminAuthOptions) {}
  static async create(options: AdminAuthOptions): Promise<AdminAuth> { const salt = Buffer.from(`acceptgpt-admin-password:${options.sessionSecret}`); const verifier = await scrypt(options.password, salt, 32) as Buffer; return new AdminAuth(verifier, options); }
  async login(password: unknown): Promise<AdminSession | null> { if (typeof password !== 'string') return null; const candidate = await scrypt(password, Buffer.from(`acceptgpt-admin-password:${this.options.sessionSecret}`), 32) as Buffer; if (candidate.length !== this.verifier.length || !timingSafeEqual(candidate, this.verifier)) return null; const random = this.options.random ?? randomBytes; const csrfToken = random(32).toString('base64url'); const expiresAt = (this.options.now ?? Date.now)() + this.options.ttlMs; const cookieValue = encodePayload({ v: 1, csrf: csrfToken, exp: expiresAt }); return { cookieValue, csrfToken, expiresAt }; }
  authenticate(cookieValue: string | undefined): AdminSession | null { if (!cookieValue) return null; const payload = decodePayload(cookieValue); if (!payload || payload.exp <= (this.options.now ?? Date.now)()) return null; return { cookieValue, csrfToken: payload.csrf, expiresAt: payload.exp }; }
  assertMutation(session: AdminSession, csrf: unknown, origin: string | undefined): void { if (session.expiresAt <= (this.options.now ?? Date.now)() || typeof csrf !== 'string' || csrf !== session.csrfToken || origin !== this.options.publicOrigin) throw new Error('CSRF_REJECTED'); }
  logout(_session: AdminSession): void {}
  close(): void {}
}
