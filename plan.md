# Plan: Fix redeem bị Cloudflare chặn + Giao diện CDK tiếng Anh

- **Trạng thái:** đã triển khai và kiểm chứng
- **Ngày:** 2026-07-15
- **Nguồn lỗi người dùng thấy:** trang "Tham gia workspace" báo **"Lời mời không được chấp nhận."** khi redeem, dù cùng session/workspace đó chạy được bằng extension `gptk12`.

---

## 1. Bối cảnh & nguyên nhân gốc (ĐÃ XÁC NHẬN)

`JOIN_REJECTED` chỉ phát ra từ [chatgpt-join-client.ts:15](src/chatgpt-join-client.ts#L15), khi cả `invites/request` và `invites/accept` trả non-2xx/non-409 và verify nói chưa-là-member.

Đã chạy probe [test/probe-join.mjs](test/probe-join.mjs) **trên đúng VPS**, gọi đúng 3 request theo 2 kiểu header:

| Kiểu | check | invites/request | invites/accept |
|---|---|---|---|
| **bare** (fetch trần như code hiện tại) | **403** cloudflare `cf-mitigated=challenge` | **403** | **403** |
| **browser** (giả Chrome: UA + sec-ch-ua + origin/referer) | **200** | **200 `{"success":true}`** | **200 `{"success":true}`** |

**Kết luận:** Cloudflare chặn ở **tầng header** (thiếu User-Agent browser). `fetch` của Node không có UA/headers của trình duyệt → bị challenge → JOIN_REJECTED.

**Hệ quả quan trọng:** **KHÔNG cần Playwright, KHÔNG cần cookie/session_token, KHÔNG cần proxy residential.** Extension chạy được chỉ vì transport của nó là browser thật; chỉ cần thêm header giả-Chrome vào Node fetch là đủ. Workspace ID (`b501c0d0-...`) đúng, token hợp lệ — không phải lỗi cấu hình/token.

---

## 2. Mục tiêu / Ngoài phạm vi

**Mục tiêu**
- A. Redeem qua web thành công như extension (bỏ 403 Cloudflare).
- C. Giao diện CDK (trang redeem + admin) hiển thị tiếng Anh, bao gồm cả text lỗi.
- B. Dọn file bí mật + thêm log chẩn đoán để lần sau lỗi hiện rõ.

**Ngoài phạm vi**
- Không viết lại sang Playwright/UI-clicking (đã chứng minh là thừa).
- Không đổi message tiếng Việt phía server/Telegram (chỉ localize ở UI).
- Không đổi luồng worker duyệt (admin browser) — giữ nguyên.

---

## 3. Hạng mục công việc

### A. Fix transport — [src/chatgpt-join-client.ts](src/chatgpt-join-client.ts)

Sửa method `call()` ([dòng 17](src/chatgpt-join-client.ts#L17)) và `requestJoin`/`verifyMembership`:

1. **Thêm bộ header giả Chrome** cho mọi request (đây là fix cốt lõi):
   ```
   user-agent:        Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
   accept-language:   en-US,en;q=0.9
   origin:            <suy từ baseUrl, vd https://chatgpt.com>
   referer:           <origin>/
   sec-ch-ua:         "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"
   sec-ch-ua-mobile:  ?0
   sec-ch-ua-platform:"Windows"
   sec-fetch-dest:    empty
   sec-fetch-mode:    cors
   sec-fetch-site:    same-origin
   ```
   Giữ nguyên `accept`, `authorization: Bearer`, `content-type`, `oai-device-id`, `oai-language`.
2. **Gửi body rỗng `''` trên POST** (hiện không gửi body) — khớp extension.
3. **Một `oai-device-id` cố định cho cả lượt `requestJoin`**: tạo 1 lần, truyền xuống request → accept → verify (thay vì `randomUUID` mỗi call). Đảm bảo `accept` khớp invite mà `request` tạo. `verifyMembership` nhận thêm tham số `deviceId` tùy chọn (mặc định tự sinh) để không phá interface `JoinClient`.
4. **User-Agent để ở 1 const** (hoặc env `CHATGPT_USER_AGENT`, default là chuỗi Chrome trên) để dễ cập nhật khi Cloudflare siết.

**Rủi ro/bảo trì:** UA có thể cũ sau vài tháng → giữ 1 chỗ để bump. Nếu Cloudflare nâng lên JS-challenge (browser-header cũng 403) thì phương án dự phòng là chạy fetch trong Playwright page — chưa cần bây giờ.

### B. Dọn dẹp + chẩn đoán

1. **Xóa file bí mật:** `rm test/probe-at.txt` (chứa access token thật).
2. **`.gitignore`:** thêm `test/probe-at.txt` và `test/probe-ws.txt`.
3. Giữ [test/probe-join.mjs](test/probe-join.mjs) làm công cụ chẩn đoán.
4. **Log status khi non-2xx** trong `call()` (chỉ status + path, **KHÔNG log token**). Port bảng nghĩa mã lỗi của extension vào `DomainError` detail:
   `401`=email domain không được phép/token hết hạn · `402/422`=workspace ngừng hoạt động · `403`=hết ghế/bị chặn · `404`=sai workspace ID · `409`=đã request/đã là member · `500`=workspace không tồn tại.

### C. Giao diện tiếng Anh — [src/web-pages.ts](src/web-pages.ts)

**Phạm vi: CẢ 2 trang** (mặc định; có thể cắt còn 1 nếu muốn).

1. **Trang redeem** `renderRedeemPage` ([dòng 4](src/web-pages.ts#L4)):
   - Tiêu đề "Tham gia workspace" → "Join workspace"
   - Notice, label `CDK`/`ChatGPT session`, placeholder, nút "Gửi yêu cầu" → "Submit request"
   - Text trạng thái/busy trong JS
2. **Trang admin** `renderAdminPage` ([dòng 6](src/web-pages.ts#L6)):
   - "Quản trị CDK" → "CDK Management", đăng nhập, workspace, tạo/xóa CDK, tiêu đề bảng lịch sử, nút, hộp confirm, message
3. **Localize text lỗi từ server (điểm dễ sót):** toast lỗi trên trang lấy từ `data.message` (server trả tiếng Việt). Chỉ dịch HTML là **chưa đủ**.
   → Trong JS mỗi trang, **map `data.code` → text tiếng Anh** (response đã có `code`). Giữ nguyên message tiếng Việt phía server/Telegram. Các code cần map: `CDK_INVALID_OR_USED`, `JOIN_REJECTED`, `ACCEPT_NOT_FOUND`, `WORKER_UNAVAILABLE`, `UPSTREAM_TIMEOUT`, `SESSION_INVALID`, `WORKSPACE_NOT_CONFIGURED`, `RATE_LIMITED`, `INVALID_INPUT`, `INTERNAL_ERROR`, `LOGIN_FAILED`, `CSRF_REJECTED`, `SUPABASE_UNAVAILABLE`, `INVALID_CDK_COUNT`, `CDK_GENERATION_FAILED`.

### D. Kiểm chứng

1. ✅ `npm run build` (tsc) + `npm test` đã chạy xanh.
2. ✅ Regression test ở [test/chatgpt-join-client.test.ts](test/chatgpt-join-client.test.ts) assert browser headers, body POST rỗng, và `oai-device-id` dùng xuyên suốt request/accept/verify.
3. ⏳ Redeem thật từ web form cần chạy với session/CDK thật trên VPS; probe vẫn được giữ để chẩn đoán, không commit token.
4. ✅ Render `/` và `/admin` đã chuyển sang tiếng Anh; test kiểm tra map `data.code` sang toast tiếng Anh.

---

## 4. Thứ tự & rollback

- **Thứ tự:** A (fix bug) → C (tiếng Anh) → B (dọn/log) → D (verify).
- **Rollback:** mỗi hạng mục độc lập; A chỉ thêm header (không đổi hành vi khi đã 2xx). Nếu A gây lỗi lạ, revert riêng file `chatgpt-join-client.ts`.

## 5. Quyết định mặc định (chỉnh nếu cần)

- Tiếng Anh cho **cả** admin page, không chỉ trang redeem.
- **Có** map mã lỗi sang tiếng Anh (nếu bỏ, toast lỗi vẫn tiếng Việt).
- Không đổi message server/Telegram.

---

## 6. Kết quả triển khai

- ✅ `ChatGptJoinClient` gửi bộ browser headers, body POST rỗng, và một `oai-device-id` cố định trong mỗi lượt join.
- ✅ Log non-2xx chỉ gồm `path` và `status`; không ghi access token.
- ✅ `test/probe-at.txt` và `test/probe-ws.txt` được ignore; không có file token local hiện hữu khi kiểm tra.
- ✅ Redeem page và admin page dùng tiếng Anh; toast tra theo error `code` thay vì hiển thị message tiếng Việt từ server.
- ✅ Kiểm chứng cục bộ: full suite 31 pass, 1 skip, 0 fail; `typecheck`, `build`, `node --check test/probe-join.mjs`, và `git diff --check` đều pass.
