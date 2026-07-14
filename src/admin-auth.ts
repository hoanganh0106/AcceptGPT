import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const ADMIN_COOKIE_NAME = '__Host-acceptgpt_admin';
export const ADMIN_COOKIE_OPTIONS = { path: '/', secure: true, httpOnly: true, sameSite: 'strict' as const, signed: true };
export interface AdminSession { id: string; csrfToken: string; expiresAt: number; }
export interface AdminAuthOptions { password: string; sessionSecret: string; ttlMs: number; publicOrigin: string; now?: () => number; random?: (size: number) => Buffer; }
export class AdminAuth {
  private constructor(private readonly verifier: Buffer, private readonly options: AdminAuthOptions, private readonly sessions: Map<string, AdminSession>) {}
  static async create(options: AdminAuthOptions): Promise<AdminAuth> { const salt = Buffer.from(`acceptgpt-admin-password:${options.sessionSecret}`); const verifier = await scrypt(options.password, salt, 32) as Buffer; return new AdminAuth(verifier, options, new Map()); }
  async login(password: unknown): Promise<AdminSession | null> { if (typeof password !== 'string') return null; const candidate = await scrypt(password, Buffer.from(`acceptgpt-admin-password:${this.options.sessionSecret}`), 32) as Buffer; if (candidate.length !== this.verifier.length || !timingSafeEqual(candidate, this.verifier)) return null; const random = this.options.random ?? randomBytes; const session = { id: random(32).toString('base64url'), csrfToken: random(32).toString('base64url'), expiresAt: (this.options.now ?? Date.now)() + this.options.ttlMs }; this.sessions.set(session.id, session); this.prune(); return session; }
  authenticate(signedCookie: string | undefined): AdminSession | null { if (!signedCookie) return null; const session = this.sessions.get(signedCookie); if (!session || session.expiresAt <= (this.options.now ?? Date.now)()) { if (session) this.sessions.delete(session.id); return null; } return session; }
  assertMutation(session: AdminSession, csrf: unknown, origin: string | undefined): void { if (!this.authenticate(session.id) || typeof csrf !== 'string' || csrf !== session.csrfToken || origin !== this.options.publicOrigin) throw new Error('CSRF_REJECTED'); }
  logout(sessionId: string): void { this.sessions.delete(sessionId); }
  close(): void { this.sessions.clear(); }
  private prune(): void { const now = (this.options.now ?? Date.now)(); for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id); while (this.sessions.size > 1000) { const first = this.sessions.keys().next().value as string | undefined; if (first) this.sessions.delete(first); else break; } }
}
