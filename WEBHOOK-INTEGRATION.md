# Kế hoạch tích hợp Webhook — AcceptGPT

> Tài liệu này gồm 2 phần: (A) **tình hình hiện tại** của hệ thống AcceptGPT, và
> (B) **spec để AI của hệ thống bên gửi** soạn code API bắn webhook sang. Có thể đưa
> nguyên **Mục 3–6** cho AI bên đó để triển khai.

---

## 1. Tình hình hiện tại

**AcceptGPT** là service chạy 24/7, nhận webhook chứa danh sách email → tự động vào trang
admin ChatGPT Business, **duyệt đúng những email đó** vào workspace → gửi kết quả về Telegram.

- Ngôn ngữ: Node.js + TypeScript + Playwright (Chromium). Job giữ trong RAM (không DB).
- Trạng thái: **đã code xong, đã test end-to-end trên WSL** (webhook → queue → worker →
  Playwright bấm Accept trên trang thật → Telegram). Đang chuẩn bị deploy lên VPS Ubuntu.
- **Hành vi duyệt (quan trọng):** với **mỗi email** trong webhook, bot tìm đúng dòng đó trong
  danh sách "Pending requests" (lọc bằng ô Search) rồi bấm **Accept của riêng dòng đó** —
  **không** "Accept all", nên không duyệt nhầm người chưa có webhook. Nếu email chưa xuất hiện
  (đến trễ), bot chờ tới `PENDING_APPEAR_WAIT_MS` (mặc định 8s) rồi mới báo "không thấy".
- Xử lý tuần tự: nhiều webhook tới sẽ vào hàng đợi và chạy lần lượt, không song song.
- Kết quả **không trả về trong HTTP response** mà báo qua **Telegram** (đã duyệt / duyệt một
  phần / không thấy / session hết hạn / lỗi).

### Luồng tổng thể

```
[Hệ thống bên gửi]  --HTTP POST /webhook (JSON + secret)-->  [AcceptGPT trên VPS]
                                                                   |
                                                     Playwright điều khiển Chromium
                                                                   v
                                                        [Trang admin ChatGPT] duyệt email
                                                                   |
                                                                   v
                                                            [Thông báo Telegram]
```

---

## 2. Việc AcceptGPT (bên mình) phải làm trước khi bên gửi tích hợp

1. Deploy lên VPS Ubuntu (xem `README.md`): cài Node, Chromium, Xvfb; build; systemd.
2. **Đăng nhập ChatGPT lần đầu qua VNC** (VPS không có màn hình):
   - Chromium chạy trên màn hình ảo `Xvfb :99`.
   - `x11vnc -localhost -display :99 -nopw -forever &` trên VPS.
   - Trên máy mình: `ssh -L 5900:localhost:5900 user@vps-ip`, mở VNC client tới `localhost:5900`,
     đăng nhập tài khoản automation (Admin, bật MFA), giải CAPTCHA. Session lưu vào
     `data/browser-profile`, chỉ làm **một lần**.
3. **Đặt reverse proxy (Caddy) + HTTPS** để webhook từ Internet tới được (backend chỉ bind
   `127.0.0.1:8080`). Đã có domain → xem [deploy/REVERSE-PROXY.md](deploy/REVERSE-PROXY.md)
   (DNS A record → Caddy tự lấy cert Let's Encrypt → `https://<domain>/webhook`).
4. **Cung cấp cho bên gửi (qua kênh bảo mật):**
   - `WEBHOOK_URL` — ví dụ `https://accept.nguyenhoanganh.dev/webhook`
   - `WEBHOOK_SECRET` — chuỗi bí mật để đặt vào header (KHÔNG gửi qua chat/công khai).

---

## 3. Hợp đồng API — bên gửi phải tuân theo

### Endpoint

```
POST  {WEBHOOK_URL}        # ví dụ: https://accept.nguyenhoanganh.dev/webhook
```

### Headers

| Header | Bắt buộc | Giá trị |
|---|---|---|
| `content-type` | ✅ | `application/json` |
| `x-webhook-secret` | ✅ | Chuỗi `WEBHOOK_SECRET` mình cấp (so khớp tuyệt đối) |

### Body (JSON)

```json
{ "emails": ["a@example.com", "b@example.com"] }
```

- `emails`: **mảng chuỗi**, là (các) email cần duyệt.
- Bên nhận tự **chuẩn hóa**: trim, chuyển **chữ thường**, bỏ rỗng, **loại trùng**. Bên gửi
  không cần lo, nhưng nên gửi email đúng như người dùng đăng ký để khớp dòng trên trang.
- Kích thước body tối đa **256 KB**.

### Phản hồi

| HTTP | Khi nào | Body ví dụ | Bên gửi xử lý |
|---|---|---|---|
| `202` | Đã nhận, đưa vào hàng đợi | `{ "queued": true, "jobId": "…", "count": 2 }` | ✅ Thành công. **Dừng, không chờ.** |
| `400` | `emails` không phải mảng / rỗng sau chuẩn hóa | `{ "error": "…" }` | ❌ Lỗi dữ liệu — **sửa request**, đừng retry |
| `401` | Thiếu/sai `x-webhook-secret` | `{ "error": "unauthorized" }` | ❌ Sai secret — **sửa cấu hình**, đừng retry |
| `5xx` / timeout / lỗi mạng | Server sự cố tạm thời | — | 🔁 **Retry có backoff** |

> **Quan trọng — bất đồng bộ:** `202` chỉ nghĩa là "đã nhận việc", **chưa** phải "đã duyệt xong".
> Kết quả duyệt (thành công / không thấy email / lỗi) được báo qua **Telegram của bên nhận**,
> KHÔNG trả về trong HTTP response. Bên gửi hãy coi đây là **fire-and-forget**.

### Health check (tuỳ chọn, để monitor)

```
GET {BASE_URL}/health  ->  200  { "status": "ok", "queued": 0, "time": "…" }
```

---

## 4. Yêu cầu về hành vi cho bên gửi

1. **Fire-and-forget:** gửi xong nhận `202` là xong, không chờ kết quả duyệt trong response.
2. **Retry đúng cách:** chỉ retry khi `5xx`/timeout/lỗi mạng (backoff vd 1s, 2s, 4s, tối đa 3–5
   lần). **Không** retry với `400`/`401` (lỗi vĩnh viễn).
3. **Timeout kết nối:** đặt ~10s cho mỗi request.
4. **Idempotent an toàn:** gửi lại cùng email nhiều lần vô hại — lần sau nếu email không còn
   trong danh sách chờ thì chỉ bị báo "không thấy", không gây tác dụng phụ.
5. **Gửi đúng email cần duyệt:** mỗi webhook nên chứa email đã được xác nhận/đủ điều kiện. Bot
   chỉ duyệt các email này, không đụng người khác.
6. **Bảo mật secret:** để `WEBHOOK_SECRET` trong biến môi trường/secret manager, không hardcode,
   không log ra ngoài.

---

## 5. Code mẫu (bên gửi tham khảo, tự chỉnh)

### Node.js (fetch)

```js
async function sendAcceptWebhook(emails) {
  const url = process.env.WEBHOOK_URL;          // https://accept.nguyenhoanganh.dev/webhook
  const secret = process.env.WEBHOOK_SECRET;    // do bên AcceptGPT cấp

  const maxRetries = 4;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
        body: JSON.stringify({ emails }),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 202) return true;                 // OK, dừng
      if (res.status === 400 || res.status === 401) {      // lỗi vĩnh viễn, không retry
        throw new Error(`Từ chối (${res.status}): ${await res.text()}`);
      }
      // còn lại (5xx...) -> rơi xuống retry
    } catch (err) {
      if (attempt === maxRetries) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1))); // 1s,2s,4s,8s
  }
  return false;
}
```

### Python (requests)

```python
import os, time, requests

def send_accept_webhook(emails: list[str]) -> bool:
    url = os.environ["WEBHOOK_URL"]
    secret = os.environ["WEBHOOK_SECRET"]
    headers = {"content-type": "application/json", "x-webhook-secret": secret}

    for attempt in range(1, 5):
        try:
            r = requests.post(url, json={"emails": emails}, headers=headers, timeout=10)
            if r.status_code == 202:
                return True
            if r.status_code in (400, 401):
                raise RuntimeError(f"Từ chối ({r.status_code}): {r.text}")
        except requests.RequestException:
            if attempt == 4:
                raise
        time.sleep(2 ** (attempt - 1))  # 1s, 2s, 4s, 8s
    return False
```

### curl (test nhanh)

```bash
curl -X POST "$WEBHOOK_URL" \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"emails":["a@example.com"]}'
```

---

## 6. Cần bên gửi cung cấp/thống nhất

- [ ] Bên gửi bắn webhook **khi nào** (sự kiện gì kích hoạt: thanh toán thành công / duyệt tay…?).
- [ ] Mỗi webhook gửi **1 email hay nhiều email**? (Cả hai đều hỗ trợ.)
- [ ] IP/nguồn gửi cố định không? (Nếu có, bên nhận có thể whitelist thêm ở firewall/reverse proxy.)
- [ ] Bên gửi có cần bên nhận trả **callback kết quả** không? (Hiện chỉ báo Telegram; nếu cần
      callback HTTP về bên gửi thì phải bổ sung — cho biết để mình làm.)

---

## 7. Thông tin cần trao đổi (điền khi deploy xong)

| Mục | Giá trị | Ghi chú |
|---|---|---|
| `WEBHOOK_URL` | `https://accept.nguyenhoanganh.dev/webhook` | Địa chỉ chính thức để gửi webhook (HTTPS) |
| `WEBHOOK_SECRET` | `f5c0ce9796176aba3a6958765a4b52d0726b68a0a0c6a4f9` | Đặt vào header `x-webhook-secret`. Giữ kín, đừng đăng công khai / commit lên repo public. |
| IP công khai VPS | `152.42.166.79` | `accept.nguyenhoanganh.dev` trỏ về IP này. Bên gửi có IP cố định → báo để whitelist. |
