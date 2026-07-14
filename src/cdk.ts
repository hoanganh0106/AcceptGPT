import { createHmac, randomBytes } from 'node:crypto';
export const CDK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CDK_PATTERN = /^[A-HJ-NP-Z2-9]{16}$/;
export interface GeneratedCdk { plaintext: string; codeHash: string; }
export function normalizeCdk(input: string): string {
  const normalized = input.replace(/[\t\n\r ]|-/g, '').toUpperCase();
  if (!CDK_PATTERN.test(normalized)) throw new Error('INVALID_CDK');
  return normalized;
}
export function formatCdk(normalized: string): string { if (!CDK_PATTERN.test(normalized)) throw new Error('INVALID_CDK'); return normalized.match(/.{4}/g)!.join('-'); }
export function hashCdk(normalized: string, secret: string): string { return createHmac('sha256', secret).update(normalized, 'utf8').digest('hex'); }
export function generateCdk(secret: string, random: (size: number) => Buffer = randomBytes): GeneratedCdk {
  const bytes = random(10); let bits = 0; let bitCount = 0; let normalized = '';
  for (const byte of bytes) { bits = (bits << 8) | byte; bitCount += 8; while (bitCount >= 5) { normalized += CDK_ALPHABET[(bits >>> (bitCount - 5)) & 31]; bitCount -= 5; } }
  return { plaintext: formatCdk(normalized), codeHash: hashCdk(normalized, secret) };
}
