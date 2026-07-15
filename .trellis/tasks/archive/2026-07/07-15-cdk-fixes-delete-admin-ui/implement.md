# Implement — Fix CDK session-invalid + redeem feedback, delete CDK, redesign admin UI

Thực thi theo thứ tự. Bug chặn redeem (#0) làm trước để có thể test end-to-end sớm.

## Bước 1 — Fix "session không hợp lệ" (`src/chatgpt-join-client.ts`)

- [ ] Trong `validateSession`, bỏ dòng lấy `accountId` từ `/me` và điều kiện
  `accountId !== claims.accountId`. Giữ kiểm tra `email` khớp `claims.email`; return
  `{ email, accountId: claims.accountId }`.
- [ ] Giữ nguyên xử lý `!response.ok` (≥500 → UPSTREAM_TIMEOUT, còn lại → SESSION_INVALID).
- [ ] Verify: tạo `test/chatgpt-join-client.test.ts`:
  - `/me` trả `{ id:'user-abc', email:'user@example.com' }`, claims
    `{ email:'user@example.com', accountId:'acc-uuid', ... }` → `validateSession` **không** throw,
    trả `accountId:'acc-uuid'`.
  - `/me` trả email khác → throw `SESSION_INVALID`.
  - `/me` status 500 → throw `UPSTREAM_TIMEOUT`.
  Inject `fetchImpl` giả. Chạy `npm test`.

## Bước 2 — Migration xóa CDK (`supabase/migrations/202607150001_cdk_delete.sql`)

- [ ] Tạo function `delete_removable_cdks(p_ids uuid[] default null)` security definer, guard
  removable (unused OR used+result∈lỗi), `p_ids null` = xóa tất cả removable. Revoke từ
  public/anon/authenticated, grant execute cho `service_role`. KHÔNG grant delete trên bảng.
  (Nội dung SQL đầy đủ ở design.md mục 2.1.)
- [ ] Verify: đọc lại file, đối chiếu danh sách result lỗi khớp `CdkResult` trong
  `src/supabase-types.ts`. (Apply thật lên Supabase ở Bước 7.)

## Bước 3 — Store + types (`src/supabase-types.ts`, `src/supabase-store.ts`)

- [ ] `supabase-types.ts`: thêm `delete_removable_cdks: { Args: { p_ids: string[] | null }; Returns: number }`
  vào `Functions`.
- [ ] `supabase-store.ts`: thêm `deleteRemovableCdks(ids: string[] | null): Promise<number>` vào
  interface `CdkStore` và class `SupabaseCdkStore` (impl ở design.md mục 2.3, dùng `safeError`).
- [ ] Verify: `npm run build` không lỗi type.

## Bước 4 — Route xóa + rate-limit VN (`src/server.ts`)

- [ ] Thêm `errorResponseBuilder` tiếng Việt vào `app.register(rateLimit, {...})`.
- [ ] Thêm route `POST /api/admin/cdks/delete` qua `mutationSession`, validate `{ids?|all?}`
  (ids: mảng UUID 1..200; hoặc `all:true`), gọi `cdkStore.deleteRemovableCdks`, trả `{deleted}`
  (503 khi Supabase lỗi). Code ở design.md mục 2.4.
- [ ] Verify: cập nhật `test/server.test.ts`:
  - build với `redeemRateLimitMax:1`, inject 2× `POST /api/redeem` → lần 2 `429` + message chứa
    "thử lại".
  - test route xóa: đăng nhập admin (login → lấy csrf từ state), gọi `POST /api/admin/cdks/delete`
    với csrf hợp lệ + `{all:true}` → 200 `{deleted}`; thiếu csrf → 403.
  Chạy `npm test`.

## Bước 5 — Viết lại trang redeem (`src/web-pages.ts` → `renderRedeemPage`)

- [ ] Design tokens + card layout (design.md mục 6).
- [ ] Giữ: câu notice khớp `/CDK.*đã dùng.*không.*hoàn lại/is`, id `redeem/cdk/session/result`,
  `role="status"`, xóa session textarea ngay khi submit.
- [ ] JS: loading state ("Đang xử lý…" + dòng nhắc), branch `response.ok && data.ok` →
  alert-success (accepted/already_member) + xóa input CDK; ngược lại alert-error
  `data.message||fallback`. Text động set bằng `textContent`. Input CDK tự uppercase khi nhập.

## Bước 6 — Viết lại trang admin (`src/web-pages.ts` → `renderAdminPage`)

- [ ] Layout header + 3 card + login card + trạng thái "Đang tải…" (design.md mục 5, 6).
- [ ] Giữ: 2 câu cảnh báo Playwright (nguyên văn, cạnh control workspace và phát CDK),
  `<pre id="created"></pre>`, không cột `<th>ID</th>`, không in id history ra HTML hiển thị, toàn
  bộ id phần tử cũ.
- [ ] `api()` gắn `error.status`; `boot()` auto-load, phân biệt 401 vs lỗi khác; login handler xử
  lý trường hợp login OK + load lỗi (nút Tải lại, không quay lại form login).
- [ ] Bảng lịch sử: badge màu theo result, thời gian `toLocaleString('vi-VN')`, empty state,
  bọc `overflow-x:auto`. Mỗi row removable có nút "Xóa" (giữ id trong closure/biến JS của row,
  không đặt vào DOM hiển thị) → `confirm()` → `POST /api/admin/cdks/delete {ids:[id]}` → reload.
- [ ] Thanh công cụ: nút "Xóa tất cả CDK có thể xóa" → `confirm()` → `{all:true}` → reload.
- [ ] Nút "Copy tất cả" cho CDK vừa tạo + dòng "CDK chỉ hiển thị một lần". Mọi nút mutation
  disabled khi request chạy.

## Bước 7 — Quality gate

- [ ] `npm run build` sạch.
- [ ] `npm test` pass toàn bộ (test cũ + mới). Test cũ `web-pages.test.ts` (security copy, không
  lộ supabase/sb_secret_, không localStorage, không `<th>ID</th>`, giữ `<pre id="created">`) phải
  pass nguyên.
- [ ] Thêm assertion `test/web-pages.test.ts`: redeem có nhánh `data.ok`/`alert-success`; admin
  có `boot`/auto-load, nút copy, và chuỗi liên quan xóa (vd `cdks/delete`).
- [ ] Grep an toàn: `grep -riE "sb_secret_|service_role|localStorage" src/web-pages.ts` → rỗng.
  Kiểm tra id CDK không lọt vào HTML hiển thị của bảng lịch sử.
- [ ] Apply migration lên Supabase (Dashboard/CLI đã xác thực). Kiểm thử thủ công: tạo vài CDK →
  xóa 1 unused (mất), thử xóa 1 CDK `accepted` bằng gọi API trực tiếp → `deleted:0`. "Xóa tất cả"
  chỉ dọn unused + lỗi.
- [ ] Mở `/` và `/admin` ở viewport 375px → không tràn ngang.
- [ ] Đối chiếu acceptance A0–A7 trong prd.md.

## Rollback point
- Code: revert commit (src + test).
- DB: `drop function public.delete_removable_cdks(uuid[]);` — không đụng bảng/row.
