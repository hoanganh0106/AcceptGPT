import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminAuth } from '../src/admin-auth';
test('admin sessions require password, exact origin, and CSRF', async () => { const auth = await AdminAuth.create({ password: 'correct horse battery staple', sessionSecret: 's'.repeat(32), ttlMs: 1000, publicOrigin: 'https://accept.example.com', random: () => Buffer.alloc(32, 1) }); assert.equal(await auth.login('wrong'), null); const session = await auth.login('correct horse battery staple'); assert.ok(session); assert.doesNotThrow(() => auth.assertMutation(session, session.csrfToken, 'https://accept.example.com')); assert.throws(() => auth.assertMutation(session, 'wrong', 'https://accept.example.com'), /CSRF_REJECTED/); assert.throws(() => auth.assertMutation(session, session.csrfToken, 'https://evil.example'), /CSRF_REJECTED/); });
test('signed session payload remains valid after creating a new AdminAuth instance', async () => {
  let now = 1_000;
  const options = { password: 'password', sessionSecret: 's'.repeat(32), ttlMs: 10_000, publicOrigin: 'https://accept.example.com', now: () => now, random: () => Buffer.alloc(32, 2) };
  const first = await AdminAuth.create(options);
  const session = await first.login('password');
  assert.ok(session);
  const restarted = await AdminAuth.create(options);
  const restored = restarted.authenticate(session.cookieValue);
  assert.deepEqual(restored, session);
  now = 11_001;
  assert.equal(restarted.authenticate(session.cookieValue), null);
});
