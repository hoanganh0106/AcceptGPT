import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCdk, normalizeCdk } from '../src/cdk';
import { CdkIssuer } from '../src/cdk-issuer';
test('CDKs use four groups and HMAC hashes', () => { const generated = generateCdk('s'.repeat(32), () => Buffer.alloc(10, 255)); assert.match(generated.plaintext, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/); assert.match(generated.codeHash, /^[0-9a-f]{64}$/); });
test('normalization ignores ASCII whitespace and hyphens', () => { assert.equal(normalizeCdk(' abcd-efgh-jkmn-pqrs '), 'ABCDEFGHJKMNPQRS'); });
test('issuer stores plaintext alongside each CDK hash', async () => {
  let items: Array<{ codeHash: string; codePlain: string }> = [];
  const issuer = new CdkIssuer({ insertCdks: async (value) => { items = value; } }, 's'.repeat(32));
  const codes = await issuer.issue(2);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.codePlain), codes.map((code) => code.replaceAll('-', '')));
  assert.equal(items.every((item) => /^[0-9a-f]{64}$/.test(item.codeHash)), true);
});
