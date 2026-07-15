import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminPage, renderRedeemPage } from '../src/web-pages';

test('pages contain security copy and no server credential contract', () => {
  const html = renderAdminPage('nonce') + renderRedeemPage('nonce');
  assert.match(html, /Playwright/);
  assert.match(html, /CDK.*join.*approval succeeds/is);
  assert.doesNotMatch(html, /sb_secret_|createClient|service_role/i);
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

test('redeem and admin pages use English copy and localize server error codes', () => {
  const redeem = renderRedeemPage('nonce');
  const admin = renderAdminPage('nonce');
  const html = redeem + admin;
  assert.match(redeem, /Join workspace/);
  assert.match(redeem, /Submit request/);
  assert.match(admin, /CDK Management/);
  assert.match(admin, /Log in/);
  assert.match(admin, /CDK_INVALID_OR_USED/);
  assert.match(admin, /The CDK is invalid or has already been used\./);
  for (const code of ['JOIN_REJECTED', 'ACCEPT_NOT_FOUND', 'WORKER_UNAVAILABLE', 'UPSTREAM_TIMEOUT', 'SESSION_INVALID', 'WORKSPACE_NOT_CONFIGURED', 'RATE_LIMITED', 'INVALID_INPUT', 'INTERNAL_ERROR', 'LOGIN_FAILED', 'CSRF_REJECTED', 'SUPABASE_UNAVAILABLE', 'INVALID_CDK_COUNT', 'CDK_GENERATION_FAILED']) {
    assert.match(html, new RegExp(code));
  }
  assert.doesNotMatch(html, /Tham gia workspace|Gửi yêu cầu|Đăng nhập|Đang xử lý|Không thể hoàn tất/);
});
