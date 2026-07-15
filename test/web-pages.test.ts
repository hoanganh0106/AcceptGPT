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
