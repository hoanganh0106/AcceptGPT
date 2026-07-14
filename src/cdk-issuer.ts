import { generateCdk } from './cdk';
import { DomainError } from './domain-error';
import type { CdkStore } from './supabase-store';
export class CdkIssuer {
  constructor(private readonly store: Pick<CdkStore, 'insertCdkHashes'>, private readonly hashSecret: string) {}
  async issue(count: number): Promise<string[]> {
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new DomainError('INVALID_CDK_COUNT', 'Số lượng CDK phải từ 1 đến 100.');
    for (let attempt = 0; attempt < 3; attempt++) { const batch = Array.from({ length: count }, () => generateCdk(this.hashSecret)); try { await this.store.insertCdkHashes(batch.map((item) => item.codeHash)); return batch.map((item) => item.plaintext); } catch (error) { if (!isUniqueHashCollision(error) || attempt === 2) throw error; } }
    throw new DomainError('CDK_GENERATION_FAILED');
  }
}
export function isUniqueHashCollision(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'CDK_HASH_COLLISION'; }
