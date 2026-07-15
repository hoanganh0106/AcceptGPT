# PRD — Fix CDK redeem feedback + redesign CDK web UI

## Bối cảnh

Web app CDK gồm 2 trang render từ `src/web-pages.ts`:

- `/` — trang redeem: người dùng nhập CDK + ChatGPT session để được duyệt vào workspace.
- `/admin` — trang quản trị: đăng nhập, cấu hình Invite Workspace ID, phát CDK, xem lịch sử.

## Vấn đề (đã xác nhận với người dùng thực tế)

1. **[Bug chính] Redeem thành công vẫn báo lỗi.** Server trả `{ ok: true, status, email }`
   không có trường `message`, nhưng client hiển thị
   `data.message || 'Không thể hoàn tất yêu cầu.'` → luôn hiện thông báo lỗi dù đã duyệt
   thành công. Người dùng tưởng CDK bị đốt oan.
2. **Admin phải đăng nhập lại mỗi lần reload** dù cookie session còn hạn — script không tự
   gọi `/api/admin/state` khi mở trang.
3. **Login thành công nhưng Supabase lỗi (503)** → UI kẹt ở form login, thông báo không nói
   rõ là mật khẩu đúng nhưng tải dữ liệu thất bại.
4. **Thông báo rate-limit (429) là tiếng Anh mặc định** của @fastify/rate-limit, lệch với UI
   tiếng Việt.
5. **Giao diện thô**: không có loading state, không phân biệt success/error bằng màu, không
   có nút copy CDK vừa tạo, bảng lịch sử không responsive.

## Yêu cầu

### Chức năng

- R1: Trang redeem hiển thị đúng kết quả:
  - Thành công `status=accepted`: thông báo thành công (màu xanh) kèm email đã duyệt.
  - Thành công `status=already_member`: thông báo email đã là thành viên workspace.
  - Thất bại: hiển thị `message` từ server (màu đỏ). Fallback lỗi chỉ dùng khi không có message.
- R2: Trang admin tự gọi `/api/admin/state` khi mở trang; nếu 401 thì hiện form login, nếu
  thành công thì vào thẳng dashboard.
- R3: Sau khi login thành công mà tải state lỗi (503), thông báo phải phân biệt rõ "đăng nhập
  đúng nhưng dịch vụ dữ liệu tạm thời lỗi", không để người dùng tưởng sai mật khẩu.
- R4: Response 429 (redeem + login) trả JSON `{ code, message }` với message tiếng Việt, client
  hiển thị được như các lỗi khác.
- R5: Redesign cả 2 trang theo phong cách hiện đại, sạch: card trắng trên nền nhạt, bo góc,
  shadow nhẹ, focus ring, nút có trạng thái loading/disabled, alert success/error phân biệt màu,
  responsive mobile. Trang admin thêm: badge màu theo kết quả trong bảng lịch sử, nút copy danh
  sách CDK vừa tạo, empty state cho bảng rỗng.

### Ràng buộc (không được vi phạm)

- C1: **Không đổi API contract** — `RedemptionResult`, các route, mã lỗi giữ nguyên. Fix R1 ở
  phía client (branch theo `data.ok`).
- C2: **CSP giữ nguyên**: toàn bộ CSS/JS inline với nonce; không CDN, không font ngoài, không
  ảnh ngoài; không dùng `localStorage`/`sessionStorage`.
- C3: Các chuỗi/phần tử mà test hiện có assert phải giữ nguyên:
  - Cảnh báo "Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK." xuất hiện cạnh
    cả control workspace lẫn control phát CDK.
  - Notice redeem khớp regex `/CDK.*đã dùng.*không.*hoàn lại/is`.
  - Không chứa `supabase|sb_secret_|createClient|service_role`.
  - Không có cột `<th>ID</th>`, không render `id` trong history, giữ `<pre id="created"></pre>`.
- C4: CDK plaintext chỉ hiển thị một lần; không log, không đưa CDK/session/secret vào URL.
- C5: Session textarea phải được xóa ngay khi submit (hành vi hiện tại — giữ nguyên).

## Acceptance criteria

- A1: Redeem thành công (mock) → trang hiện thông báo xanh kèm email; không còn chuỗi
  "Không thể hoàn tất yêu cầu." trong trường hợp `ok: true`.
- A2: Mở `/admin` khi đã có cookie hợp lệ → vào thẳng dashboard không cần nhập lại mật khẩu.
- A3: Login đúng + state 503 → thông báo nêu rõ dịch vụ dữ liệu lỗi (không phải sai mật khẩu).
- A4: Gửi redeem vượt rate limit → 429 với `message` tiếng Việt, hiển thị trên trang.
- A5: `npm run build` và `npm test` pass toàn bộ, gồm test hiện có ở
  `test/web-pages.test.ts` và `test/server.test.ts`.
- A6: Cả 2 trang dùng được trên mobile (viewport 375px không tràn ngang; bảng lịch sử cuộn
  ngang trong container riêng).
