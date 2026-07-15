# Design — Fix CDK session-invalid + redeem feedback, delete CDK, redesign admin UI

## Phạm vi thay đổi

| File | Thay đổi |
|---|---|
| `src/chatgpt-join-client.ts` | **Fix session-invalid**: bỏ account_id cross-check trong `validateSession` |
| `supabase/migrations/202607150001_cdk_delete.sql` | **Mới**: RPC `delete_removable_cdks` + cấp quyền |
| `src/supabase-types.ts` | Thêm khai báo Function `delete_removable_cdks` |
| `src/supabase-store.ts` | Thêm method `deleteRemovableCdks(ids | null): Promise<number>` |
| `src/server.ts` | Route `POST /api/admin/cdks/delete` + `errorResponseBuilder` rate-limit VN |
| `src/web-pages.ts` | Viết lại `renderRedeemPage` + `renderAdminPage` (UI mới + fix client + nút xóa) |
| `test/chatgpt-join-client.test.ts` | **Mới**: test validateSession không còn false-negative |
| `test/server.test.ts` | Thêm test route xóa + 429 message tiếng Việt |
| `test/web-pages.test.ts` | Thêm assertion success-branch, auto-load, nút xóa/copy |

**Không đụng**: `redemption-service.ts` (thứ tự validate→claim đã đúng), `cdk.ts`, `cdk-issuer.ts`,
`admin-auth.ts`, `queue.ts`, Caddyfile.

---

## 1. Fix "session không hợp lệ" (BUG #0 — ưu tiên cao nhất)

`src/chatgpt-join-client.ts` → `validateSession`. Hiện tại:

```ts
const email = this.findString(body, ['email'])?.toLowerCase();
const accountId = this.findString(body, ['chatgpt_account_id', 'account_id', 'id']);
if (!email || !accountId || email !== claims.email || accountId !== claims.accountId) throw SESSION_INVALID;
return { email, accountId };
```

Sửa thành (tin JWT cho accountId, /me chỉ để xác nhận token sống + email khớp):

```ts
const email = this.findString(body, ['email'])?.toLowerCase();
if (!email || email !== claims.email) throw new DomainError('SESSION_INVALID', 'Session không hợp lệ.');
return { email, accountId: claims.accountId };
```

Lý do:
- `claims.accountId` đã được `decodeSessionClaims` đảm bảo non-empty (throw nếu thiếu), và JWT
  do OpenAI ký nên đáng tin.
- `/backend-api/me` **không** chứa `chatgpt_account_id` ở root; so sánh với `id`=`"user-…"` luôn
  lệch. Đây chính là nguồn `SESSION_INVALID`.
- Giữ lời gọi `/me` (đã có retry/timeout) làm bước liveness TRƯỚC khi `claimCdk` → token chết bị
  chặn trước khi đốt CDK (đúng ràng buộc R0/C4). `response.status >= 500` vẫn map `UPSTREAM_TIMEOUT`.
- Email luôn có ở root `/me` nên không tạo false-negative mới.

**Không** đổi `requestJoin`/`verifyMembership` — đã khớp userscript (request→accept→verify, coi
`ok||409` là chấp nhận, `verifyMembership` dựa trên `text.includes(workspaceId)`).

---

## 2. Tính năng xóa CDK (BUG #6)

### 2.1 Migration `supabase/migrations/202607150001_cdk_delete.sql`

Định nghĩa "removable" = `status='unused'` OR (`status='used'` AND `result` ∈ nhóm lỗi).
Dùng **security definer** để guard nằm trong DB và KHÔNG phải cấp `delete` trực tiếp cho
`service_role` (tránh xóa vượt phạm vi qua PostgREST). `p_ids = null` → xóa tất cả removable;
ngược lại chỉ xóa các id removable trong mảng.

```sql
create or replace function public.delete_removable_cdks(p_ids uuid[] default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare deleted integer;
begin
  delete from public.cdks c
  where (p_ids is null or c.id = any(p_ids))
    and (c.status = 'unused'
      or (c.status = 'used' and c.result in
          ('join_rejected','accept_not_found','worker_unavailable','upstream_timeout',
           'internal_error','service_interrupted')));
  get diagnostics deleted = row_count;
  return deleted;
end; $$;
revoke all on function public.delete_removable_cdks(uuid[]) from public, anon, authenticated;
grant execute on function public.delete_removable_cdks(uuid[]) to service_role;
```

Ghi chú:
- Trigger `cdks_enforce_one_way` chỉ chặn UPDATE, không chặn DELETE → xóa không vướng trigger.
- KHÔNG `grant delete on table cdks` cho bất kỳ role nào; đường xóa duy nhất là RPC có guard.
- `accepted`/`already_member`/`processing` không nằm trong danh sách → không bao giờ bị xóa.

### 2.2 `src/supabase-types.ts`

Thêm vào `Functions`:
```ts
delete_removable_cdks: { Args: { p_ids: string[] | null }; Returns: number };
```

### 2.3 `src/supabase-store.ts`

Thêm vào interface `CdkStore` và class:
```ts
deleteRemovableCdks(ids: string[] | null): Promise<number>;
// impl:
async deleteRemovableCdks(ids: string[] | null): Promise<number> {
  const { data, error } = await this.client.rpc('delete_removable_cdks', { p_ids: ids });
  if (error) throw safeError('delete_cdks', error);
  return typeof data === 'number' ? data : 0;
}
```

### 2.4 Route `src/server.ts`

```ts
app.post('/api/admin/cdks/delete', async (request, reply) => {
  if (!mutationSession(request, reply)) return;
  const body = request.body as { ids?: unknown; all?: unknown } | null;
  let ids: string[] | null;
  if (body?.all === true) ids = null;
  else {
    if (!Array.isArray(body?.ids) || body.ids.length < 1 || body.ids.length > 200
        || !body.ids.every((v) => typeof v === 'string' && UUID.test(v)))
      return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Danh sách CDK không hợp lệ.' });
    ids = body.ids;
  }
  try { const deleted = await dependencies.cdkStore.deleteRemovableCdks(ids);
        return reply.header('cache-control', 'no-store').send({ deleted }); }
  catch { return reply.code(503).send({ code: 'SUPABASE_UNAVAILABLE', message: 'Dịch vụ tạm thời không khả dụng.' }); }
});
```
Dùng chung `mutationSession` (CSRF + Origin) như `PUT /workspace` và `POST /cdks` (ràng buộc C6).

---

## 3. Rate-limit message tiếng Việt (BUG #4)

`src/server.ts`, thêm vào options `app.register(rateLimit, {...})`:
```ts
errorResponseBuilder: () => ({ code: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.' })
```
Áp cho mọi route có `config.rateLimit`. Client hai trang đều đọc `data.message`.

---

## 4. Fix redeem feedback (BUG #1) — client trong `renderRedeemPage`

Branch theo `data.ok` thay vì chỉ đọc `data.message`:
```js
const data = await response.json();
if (response.ok && data.ok) {
  show('success', data.status === 'already_member'
    ? 'Email ' + data.email + ' đã là thành viên workspace.'
    : 'Đã duyệt thành công cho ' + data.email + '. Hãy kiểm tra ChatGPT.');
  document.getElementById('cdk').value = '';      // code đã dùng
} else {
  show('error', data.message || 'Không thể hoàn tất yêu cầu.');
}
```
`show(type,text)` set `textContent` + class `alert alert-success|alert-error` lên `#result`
(giữ `role="status"`). Email chèn bằng `textContent` (không XSS). Trong lúc chờ: nút disabled +
"Đang xử lý…" + dòng "Đang gửi yêu cầu, vui lòng không đóng trang." (redeem có thể mất hàng chục
giây do chờ Playwright).

---

## 5. Admin auto-load + phân biệt 503 (BUG #2, #3) — client trong `renderAdminPage`

```js
function api(url, options){ /* ... */ if(!r.ok){ const e=new Error(d.message||'Yêu cầu thất bại'); e.status=r.status; throw e; } return d; }
async function boot(){ try{ await load(); } catch(err){
  if(err.status===401) showLogin();
  else { showLogin(); message.textContent='Dịch vụ dữ liệu tạm thời lỗi: '+err.message; } } }
boot();
```
- `api()` gắn `error.status` để phân biệt 401 vs 503.
- Login handler: login OK nhưng `load()` lỗi ≠401 → giữ trạng thái đã đăng nhập, hiện
  "Đăng nhập thành công nhưng chưa tải được dữ liệu — thử tải lại." + nút "Tải lại" (gọi lại
  `load()`), KHÔNG hiện lại form login.
- Trang hiện "Đang tải…" khi boot để tránh flash form login.

---

## 6. UI mới (cả 2 trang, trọng tâm admin)

### Nguyên tắc
- CSS inline `<style nonce>`, JS inline `<script nonce>` — giữ cơ chế nonce + escape như cũ.
- Design tokens (`:root`): `--bg:#f4f6fb; --card:#fff; --text:#1a2233; --muted:#5b6474;
  --accent:#4f46e5; --ok-bg:#e7f6ec; --ok-text:#166534; --err-bg:#fdecec; --err-text:#b91c1c;
  --warn-bg:#fff4d6; --warn-text:#92400e; --border:#e3e8f0; --radius:14px;`
- Font system-ui; CDK/codes dùng `ui-monospace, Consolas, monospace`.
- Card: nền trắng, radius, `box-shadow:0 8px 24px rgba(20,30,60,.08)`, border 1px, padding 1.5–2rem.
- Input/textarea: border 1px, radius 10px, focus `outline:3px solid rgba(79,70,229,.25)`.
- Button primary: nền `--accent`, chữ trắng, hover đậm, `:disabled` mờ + `cursor:not-allowed`.
  Button danger (xóa): viền/nền đỏ nhạt, chữ `--err-text`.
- Alert: `.alert-success/.alert-error/.alert-warn` theo tokens.
- Responsive: card max-width 640px (redeem)/960px (admin), padding 1rem mobile, bảng lịch sử bọc
  `div` `overflow-x:auto`.

### Trang redeem `/`
- Header tiêu đề + subtitle luồng.
- Notice cảnh báo (giữ nguyên câu để pass regex C3) render `alert-warn`.
- Form card: input CDK (monospace, `autocapitalize=characters`, placeholder
  `XXXX-XXXX-XXXX-XXXX`, JS tự uppercase khi nhập), textarea session (helper: dán accessToken
  hoặc JSON session), nút submit full-width. `#result` là alert box, giữ `role="status"`.

### Trang admin `/admin`
- Header thanh trên: tiêu đề + nút Đăng xuất (ẩn khi chưa login). Login card giữa màn khi 401.
  Trạng thái "Đang tải…" khi boot.
- 3 card:
  1. **Workspace**: câu cảnh báo Playwright (C3) + input UUID + nút Lưu.
  2. **Phát CDK**: câu cảnh báo Playwright (C3, lần 2) + input số lượng (1–100) + nút Tạo CDK +
     `<pre id="created"></pre>` (giữ tag/id) + nút "Copy tất cả" (`navigator.clipboard.writeText`,
     chỉ hiện khi có codes) + dòng "CDK chỉ hiển thị một lần, hãy lưu ngay."
  3. **Lịch sử**: thanh công cụ có nút "Xóa tất cả CDK có thể xóa" (gọi delete `{all:true}` sau
     `confirm()`), rồi bảng cột Trạng thái / Email / Workspace / Kết quả / Thời gian / (Thao tác).
     - `result` render **badge màu**: `accepted|already_member` xanh; `processing` xám;
       `service_interrupted|internal_error|worker_unavailable|upstream_timeout` đỏ;
       `join_rejected|accept_not_found` cam.
     - `used_at` format `toLocaleString('vi-VN')`.
     - Cột Thao tác: nút "Xóa" chỉ hiện khi row removable (unused, hoặc used với result nhóm lỗi);
       row `accepted/already_member/processing` không có nút. Click → `confirm()` → delete
       `{ids:[id]}` → reload history.
     - Empty state "Chưa có CDK nào.".
     - **Không** render `id` ra text/HTML hiển thị; id chỉ giữ trong JS (vd `dataset`/closure) để
       gọi API xóa — vẫn thỏa C3 (không có `<th>ID</th>`, không in id ra HTML nhìn thấy). Test C3
       chỉ cấm cột ID và mảng `['id','status'...]` cũ; giữ id trong data-attribute là chấp nhận
       được, nhưng để chắc chắn pass, ưu tiên giữ id trong biến JS/closure của hàng, không đặt
       vào DOM. (Xem bước test.)
- Mọi nút mutation (lưu/tạo/xóa) disabled khi request đang chạy.

### Giữ nguyên ID phần tử
`redeem, cdk, session, result` / `login, password, login-button, dashboard, workspace,
save-workspace, count, create-cdks, created, logout, history, message`.

## 7. Bảo mật — không đổi
CSP, cookie `__Host-`, CSRF (`x-csrf-token`+Origin), no-store giữ nguyên. Route xóa qua
`mutationSession`. Không đưa CDK/session vào URL/storage; session textarea xóa khi submit. Render
động bằng `textContent`/`createElement` (không `innerHTML`).

## Tradeoff / quyết định
- Fix BUG #0 bằng cách bỏ account_id cross-check (không thay JWT/claims schema) — tối thiểu, khớp
  hành vi userscript đã chạy được.
- Fix BUG #1 phía client — không đụng `RedemptionResult`.
- Xóa CDK giới hạn unused + lỗi, guard trong DB bằng security-definer để không nới quyền delete.
- Không thêm dark mode / framework CSS — single-file inline, 0 dependency mới, tôn trọng CSP.

## Rollback
- Code: revert commit (chỉ src + test).
- DB: migration mới chỉ thêm 1 function; rollback = `drop function public.delete_removable_cdks(uuid[]);`
  Không đổi bảng/row hiện có.
