import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCdk, normalizeCdk } from '../src/cdk';
test('CDKs use four groups and HMAC hashes', () => { const generated = generateCdk('s'.repeat(32), () => Buffer.alloc(10, 255)); assert.match(generated.plaintext, /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/); assert.match(generated.codeHash, /^[0-9a-f]{64}$/); });
test('normalization ignores ASCII whitespace and hyphens', () => { assert.equal(normalizeCdk(' abcd-efgh-jkmn-pqrs '), 'ABCDEFGHJKMNPQRS'); });
