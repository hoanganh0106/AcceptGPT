import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminPage, renderRedeemPage } from '../src/web-pages';

test('pages contain security copy and no server credential contract', () => {
  const html = renderAdminPage('nonce') + renderRedeemPage('nonce');
  assert.match(html, /Playwright/);
  assert.match(html, /CDK.*tham gia.*thành công/is);
  assert.doesNotMatch(html, /supabase|sb_secret_|createClient|service_role/i);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
});
test('admin history shows CDK values and supports query pagination', () => {
  const html = renderAdminPage('nonce');
  assert.doesNotMatch(html, /<th>ID<\/th>/);
  assert.match(html, /<th>CDK<\/th>/);
  assert.match(html, /q=/);
  assert.match(html, /<pre id="created"><\/pre>/);
});
test('pages provide outcome-aware feedback and responsive admin controls', () => {
  const redeem = renderRedeemPage('nonce');
  assert.match(redeem, /data\.ok/); assert.match(redeem, /result-success/); assert.match(redeem, /result-error/); assert.match(redeem, /aria-busy/);
  const admin = renderAdminPage('nonce');
  assert.match(admin, /boot\(\)/); assert.match(admin, /navigator\.clipboard\.writeText/); assert.match(admin, /class="history-wrap"/); assert.match(admin, /badge-/); assert.match(admin, /api\/admin\/cdks\/delete/);
});
