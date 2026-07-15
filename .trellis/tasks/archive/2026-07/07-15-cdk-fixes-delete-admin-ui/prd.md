# PRD — Fix CDK session-invalid + redeem feedback, delete CDK, redesign admin UI

## Bối cảnh

Web app CDK gồm 2 trang render từ `src/web-pages.ts`:
- `/` — trang redeem: người dùng nhập CDK + ChatGPT session để được duyệt vào workspace.
- `/admin` — trang quản trị: đăng nhập, cấu hình Invite Workspace ID, phát CDK, xem lịch sử.

Backend duyệt qua `ChatGptJoinClient` (`src/chatgpt-join-client.ts`) gọi ChatGPT backend-api,
theo mẫu userscript đã chạy được `gptk12.txt`. Store Supabase ở `src/supabase-store.ts`,
schema ở `supabase/migrations/202607140001_cdk_invite.sql`.

## Vấn đề (đã xác nhận với người dùng thực tế)

0. **[BUG CHẶN 100% — ưu tiên cao nhất] Luôn báo "session không hợp lệ".**
   `validateSession` gọi `GET /backend-api/me` rồi bắt buộc `accountId` từ response phải khớp
   `claims.accountId`. Nhưng `claims.accountId` = `chatgpt_account_id` giải mã từ JWT (UUID tài
   khoản), còn `/backend-api/me` không trả `chatgpt_account_id` ở root — root chỉ có `id` dạng
   `"user-xxxx"`. `findString(body, ['chatgpt_account_id','account_id','id'])` trả `"user-xxxx"`,
   không bao giờ khớp UUID → luôn ném `SESSION_INVALID`, kể cả session hợp lệ. Userscript gốc
   tin JWT (đã được OpenAI ký), chỉ dùng `/me`+`check/v4` verify membership, KHÔNG cross-check
   account_id. Bước kiểm tra này thừa và so sai loại định danh.

1. **[Bug] Redeem thành công vẫn báo lỗi.** Server trả `{ ok: true, status, email }` không có
   `message`, nhưng client render `data.message || 'Không thể hoàn tất yêu cầu.'` → thành công
   vẫn hiện thông báo lỗi, người dùng tưởng CDK bị đốt oan.
2. **Admin phải đăng nhập lại mỗi lần reload** dù cookie còn hạn — script không tự gọi
   `/api/admin/state` khi mở trang.
3. **Login đúng nhưng Supabase 503** → UI kẹt ở form login, gây hiểu lầm sai mật khẩu.
4. **Rate-limit (429) trả tiếng Anh mặc định** của @fastify/rate-limit, lệch UI tiếng Việt.
5. **Giao diện thô** (đặc biệt trang admin): không loading state, không phân biệt success/error
   bằng màu, không nút copy CDK, bảng lịch sử không responsive, không empty state.
6. **[Tính năng mới] Không xóa được CDK cũ.** Migration cố ý không cấp quyền `delete`; cần bổ
   sung khả năng xóa CDK chưa dùng và CDK có kết quả lỗi.

## Yêu cầu

### Chức năng

- R0: Sửa `validateSession` để session hợp lệ redeem được. Bỏ ràng buộc account_id cross-check;
  giữ `/me` như bước kiểm tra token còn sống + email khớp `claims.email`; `accountId` tin từ JWT
  (đã validate non-empty ở `decodeSessionClaims`). Không được đốt CDK cho token đã chết (giữ
  thứ tự: validate trước, `claimCdk` sau).
- R1: Trang redeem hiển thị đúng kết quả theo `data.ok`:
  - `accepted` → thông báo thành công (xanh) + email đã duyệt.
  - `already_member` → thông báo email đã là thành viên workspace.
  - thất bại → `message` từ server (đỏ); fallback chỉ khi không có message.
- R2: Trang admin tự gọi `/api/admin/state` khi mở; 401 → form login, thành công → vào dashboard.
- R3: Login đúng nhưng tải state lỗi (503) → thông báo rõ "đăng nhập đúng, dịch vụ dữ liệu tạm
  thời lỗi" + nút Tải lại; không hiện lại form login (cookie đã set).
- R4: 429 (redeem + login) trả JSON `{ code, message }` tiếng Việt; client hiển thị được.
- R5: Redesign cả 2 trang, trọng tâm trang admin, phong cách hiện đại sạch: card trắng nền nhạt,
  bo góc, shadow nhẹ, focus ring, nút có loading/disabled, alert success/error phân biệt màu,
  responsive mobile. Admin thêm: badge màu theo kết quả trong bảng lịch sử, nút copy danh sách
  CDK vừa tạo, empty state bảng rỗng.
- R6: **Xóa CDK.** Cho phép xóa CDK khi `status='unused'` HOẶC (`status='used'` và `result` thuộc
  nhóm lỗi: `join_rejected, accept_not_found, worker_unavailable, upstream_timeout, internal_error,
  service_interrupted`). KHÔNG xóa CDK `accepted`/`already_member` (giữ audit thành công) và
  KHÔNG xóa `processing` (còn đang chạy). Guard thực thi ở DB. UI: nút xóa từng dòng (chỉ hiện ở
  dòng xóa được) + nút "Xóa tất cả CDK có thể xóa"; đều có bước xác nhận trước khi xóa.

### Ràng buộc (không được vi phạm)

- C1: **Không đổi contract của redeem** — `RedemptionResult`, route redeem, mã lỗi giữ nguyên.
  Fix R1 ở client (branch theo `data.ok`).
- C2: **CSP giữ nguyên**: CSS/JS inline với nonce; không CDN/font/ảnh ngoài; không
  `localStorage`/`sessionStorage`.
- C3: Giữ nguyên các chuỗi/phần tử test đang assert (xem `test/web-pages.test.ts`):
  câu "Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK." cạnh cả 2 control;
  notice redeem khớp `/CDK.*đã dùng.*không.*hoàn lại/is`; không chứa
  `supabase|sb_secret_|createClient|service_role`; không có `<th>ID</th>`, không render `id` của
  history ra HTML, giữ `<pre id="created"></pre>`.
- C4: CDK plaintext chỉ hiển thị một lần; không log; không đưa CDK/session/secret vào URL.
- C5: Session textarea xóa ngay khi submit (giữ hành vi hiện tại).
- C6: **Xóa là thao tác quản trị**: route xóa phải qua `mutationSession` (CSRF + Origin check)
  như các route mutation admin khác. Không bao giờ đảo trạng thái CDK `used`→`unused` (trigger DB
  vẫn cấm); xóa là xóa hẳn row, chỉ áp dụng cho phạm vi R6.

## Acceptance criteria

- A0: Với session hợp lệ (token còn hạn, /me trả email khớp) → redeem không còn ném
  `SESSION_INVALID`; token đã hết hạn/không hợp lệ vẫn bị chặn TRƯỚC khi CDK bị đốt.
- A1: Redeem thành công (mock) → trang hiện thông báo xanh kèm email; trường hợp `ok:true` không
  còn chuỗi "Không thể hoàn tất yêu cầu.".
- A2: Mở `/admin` khi cookie hợp lệ → vào thẳng dashboard, không nhập lại mật khẩu.
- A3: Login đúng + state 503 → thông báo nêu rõ dịch vụ dữ liệu lỗi (không phải sai mật khẩu).
- A4: Redeem vượt rate limit → 429 với `message` tiếng Việt hiển thị trên trang.
- A5: Xóa 1 CDK unused/lỗi từ UI → row biến mất khỏi lịch sử sau reload; thử xóa CDK
  `accepted`/`processing` (kể cả gọi API trực tiếp) → không bị xóa. "Xóa tất cả" dọn đúng phạm vi
  R6, giữ lại CDK thành công/đang xử lý.
- A6: `npm run build` + `npm test` pass toàn bộ (gồm test hiện có + test mới cho `validateSession`
  và route xóa). Migration mới apply sạch trên schema hiện tại.
- A7: Cả 2 trang dùng được trên mobile (viewport 375px không tràn ngang; bảng lịch sử cuộn ngang
  trong container riêng).
