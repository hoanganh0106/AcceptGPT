import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminPage, renderRedeemPage } from '../src/web-pages';
test('pages contain security copy and no server credential contract', () => { const html = renderAdminPage('nonce') + renderRedeemPage('nonce'); assert.match(html, /Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK\./); assert.match(html, /CDK.*đã dùng.*không.*hoàn lại/is); assert.doesNotMatch(html, /supabase|sb_secret_|createClient|service_role/i); assert.doesNotMatch(html, /localStorage|sessionStorage/); });
test('admin history hides internal record IDs and keeps newly issued CDKs visible', () => {
  const html = renderAdminPage('nonce');
  assert.doesNotMatch(html, /<th>ID<\/th>/);
  assert.doesNotMatch(html, /\['id','status'/);
  assert.match(html, /<pre id="created"><\/pre>/);
});
test('pages provide outcome-aware feedback and responsive admin controls', () => {
  const redeem = renderRedeemPage('nonce');
  assert.match(redeem, /data\.ok/);
  assert.match(redeem, /result-success/);
  assert.match(redeem, /result-error/);
  assert.match(redeem, /aria-busy/);

  const admin = renderAdminPage('nonce');
  assert.match(admin, /boot\(\)/);
  assert.match(admin, /Đăng nhập thành công nhưng chưa tải được dữ liệu/);
  assert.match(admin, /id="copy-created"/);
  assert.match(admin, /navigator\.clipboard\.writeText/);
  assert.match(admin, /class="history-wrap"/);
  assert.match(admin, /Chưa có CDK nào\./);
  assert.match(admin, /badge-/);
  assert.match(admin, /api\/admin\/cdks\/delete/);
  assert.match(admin, /Xóa tất cả CDK có thể xóa/);
});
