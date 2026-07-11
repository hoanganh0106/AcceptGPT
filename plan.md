# Plan tool tự động duyệt thành viên ChatGPT Business

## 1. Mục tiêu

Xây một service chạy 24/7 trên VPS Ubuntu.

Khi nhận webhook chứa danh sách email, service sẽ:

1. Reload trang quản lý thành viên.
2. Bấm **Accept all**.
3. Đọc tổng số thành viên hiện tại của workspace.
4. Gửi kết quả về Telegram.

Không dùng SQL. Job chỉ giữ trong RAM.

---

## 2. Công nghệ cần dùng

* VPS Ubuntu
* Node.js + TypeScript
* Playwright
* Chromium
* Xvfb để chạy trình duyệt có giao diện trên VPS
* noVNC để đăng nhập thủ công khi cần
* Fastify hoặc Express để nhận webhook
* Telegram Bot API để gửi thông báo
* systemd để service tự chạy lại khi VPS reboot hoặc process lỗi

---

## 3. Tài khoản ChatGPT

Dùng một tài khoản riêng của bạn trong workspace.

Ưu tiên cấp quyền **Admin** nếu Admin có thể duyệt thành viên. Chỉ dùng Owner nếu thực tế bắt buộc.

Đăng nhập thủ công lần đầu qua noVNC. Chromium dùng persistent profile để giữ cookie và session.

---

## 4. Cách browser hoạt động

Khi service khởi động:

1. Mở Chromium bằng persistent profile.
2. Mở sẵn trang quản lý thành viên.
3. Giữ browser và một tab duy nhất chạy liên tục.
4. Không đóng browser sau mỗi webhook.

Nếu tab bị crash thì tạo tab mới. Nếu Chromium bị lỗi thì mở lại bằng cùng profile.

---

## 5. Webhook

Webhook nhận dạng:

```json
{
  "emails": [
    "a@example.com",
    "b@example.com"
  ]
}
```

Backend cần:

* Kiểm tra `emails` là mảng.
* Loại bỏ email trống.
* Chuẩn hóa chữ thường.
* Đưa request vào queue trong RAM.
* Trả phản hồi ngay, không chờ Playwright xử lý xong.

Nếu nhiều webhook đến cùng lúc, xử lý lần lượt, không chạy song song.

---

## 6. Luồng xử lý mỗi webhook

1. Lấy một job từ queue.
2. Kiểm tra browser và tab còn hoạt động.
3. Kiểm tra session ChatGPT còn đăng nhập.
4. Điều hướng về đúng trang Members nếu tab đang ở trang khác.
5. Reload trang.
6. Chờ trang tải xong.
7. Tìm nút **Accept all**.
8. Nếu có nút:

   * Bấm Accept all.
   * Xử lý modal xác nhận nếu có.
   * Chờ thao tác hoàn tất.
   * Reload lại trang.
   * Đọc tổng số thành viên hiện tại.
   * Gửi Telegram thành công.
9. Nếu không có nút Accept all:

   * Coi là không có yêu cầu chờ.
   * Đọc tổng số thành viên nếu có thể.
   * Gửi Telegram thông báo không có đơn.
10. Chuyển sang job tiếp theo.

---

## 7. Selector Playwright

Ưu tiên:

1. `getByRole`
2. `getByText`
3. `data-testid` nếu giao diện có
4. XPath tương đối khi cần

Không dùng XPath tuyệt đối kiểu `/html/body/...`.

Toàn bộ selector nên đặt trong một file riêng để dễ sửa khi giao diện ChatGPT thay đổi.

---

## 8. Telegram

### Thành công

```text
✅ Đã duyệt thành viên

Email:
- a@example.com
- b@example.com

Tổng thành viên hiện tại: 37
```

### Không có yêu cầu chờ

```text
⚠️ Không có yêu cầu thành viên để duyệt

Email từ webhook:
- a@example.com
- b@example.com

Tổng thành viên hiện tại: 35
```

### Không đọc được số lượng

```text
✅ Đã duyệt thành viên

Email:
- a@example.com
- b@example.com

Tổng thành viên hiện tại: Không xác định
```

### Session hết hạn

```text
⚠️ Phiên đăng nhập ChatGPT đã hết hạn

Bot đã dừng xử lý.
Hãy đăng nhập lại trên VPS.
```

### Lỗi xử lý

```text
❌ Duyệt thành viên thất bại

Email:
- a@example.com
- b@example.com

Lỗi: Không tìm thấy nút Accept all
```

---

## 9. Đọc tổng số thành viên

Ưu tiên đọc con số tổng được hiển thị trực tiếp trên giao diện Members.

Không đếm số dòng nếu danh sách có phân trang.

Nếu duyệt thành công nhưng không đọc được tổng số, vẫn gửi Telegram với giá trị `Không xác định`.

---

## 10. Xử lý lỗi

* Session hết hạn: dừng worker và báo Telegram.
* Tab crash: mở tab mới rồi thử lại.
* Browser crash: mở lại Chromium bằng persistent profile.
* Trang tải lỗi: reload lại một số lần.
* Không thấy Accept all: báo không có yêu cầu chờ.
* Giao diện thay đổi hoặc nút không rõ: không click bừa, chụp screenshot và báo Telegram.
* Telegram gửi lỗi: thử gửi lại vài lần.
* VPS restart: chấp nhận mất các job đang nằm trong RAM.

---

## 11. Bảo mật

* noVNC chỉ mở qua SSH tunnel, không public Internet.
* Backend webhook đặt sau Caddy hoặc Nginx.
* Chỉ mở cổng HTTPS và SSH.
* Telegram token và cấu hình đặt trong `.env`.
* Browser profile chỉ cho Linux user chạy service đọc.
* Không lưu mật khẩu ChatGPT trong code.
* Bật MFA cho tài khoản automation.

---

## 12. Cấu trúc project

```text
src/
  main.ts
  config.ts
  server.ts
  queue.ts
  browser-manager.ts
  workspace-page.ts
  worker.ts
  telegram.ts
  logger.ts

data/
  browser-profile/

logs/
screenshots/

.env
.env.example
```

---

## 13. Chạy production

Dùng systemd để:

* Khởi động Xvfb.
* Khởi động service Node.js.
* Tự restart nếu process lỗi.
* Tự chạy lại sau khi VPS reboot.
* Ghi log vào journald.

---

## 14. Thứ tự triển khai

1. Cài VPS, Node.js, Playwright, Chromium và Xvfb.
2. Cài noVNC và đăng nhập ChatGPT thủ công.
3. Xác định URL trang Members.
4. Xác định selector Accept all, modal và tổng số thành viên.
5. Làm Browser Manager giữ Chromium mở liên tục.
6. Làm webhook nhận danh sách email.
7. Làm queue trong RAM.
8. Làm flow reload và Accept all.
9. Làm Telegram notification.
10. Test khi:

* Có pending request.
* Không có pending request.
* Session hết hạn.
* Browser crash.
* Nhiều webhook đến cùng lúc.

11. Đưa service vào systemd.
12. Chạy thử vài ngày trước khi dùng chính thức.

## 15. Lưu ý quan trọng

Bot sẽ bấm **Accept all**, nên nếu webhook gửi 2 email nhưng workspace có 5 yêu cầu chờ, cả 5 yêu cầu sẽ được duyệt. Telegram vẫn chỉ hiển thị danh sách email nhận từ webhook và tổng thành viên hiện tại sau thao tác.
