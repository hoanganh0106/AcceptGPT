# Triển khai thử trên WSL (Ubuntu-22.04) trước khi lên VPS

WSL2 trên Windows 11 có sẵn **WSLg** (GUI) nên có thể đăng nhập ChatGPT bằng cửa sổ
Chromium hiện thẳng trên Windows — **không cần Xvfb/noVNC** ở bước test này. Đây là điểm
khác so với VPS thật (VPS không có màn hình nên mới cần Xvfb + noVNC).

Môi trường đã kiểm tra: Ubuntu 22.04, WSL2, user `root`, systemd đang chạy, `DISPLAY=:0`.

---

## 0. Nếu WSL bị kẹt không khởi động được

Nếu `wsl` báo `CreateInstance E_FAIL` / `Catastrophic failure` (VM bị treo), làm 1 trong 2:

**Cách A — reboot Windows** (chắc ăn nhất).

**Cách B — PowerShell chạy bằng Administrator:**
```powershell
Restart-Service WSLService -Force
wsl --shutdown
wsl -d Ubuntu-22.04    # mở lại
```

Sau khi vào lại được (`wsl -d Ubuntu-22.04 -- bash -c "whoami"` in ra `root`), tiếp tục mục 1.

---

## 1. Cài đặt (một lệnh)

```bash
bash /mnt/d/Du_an/AcceptGPT/deploy/wsl-setup.sh
```

Script sẽ: cài Node 24 (nếu thiếu) → copy project sang `/opt/accept-gpt` → `npm ci`
→ cài Chromium + thư viện hệ thống → `npm run build`.

> Chạy từ `/opt/accept-gpt` (ext4) chứ KHÔNG chạy trực tiếp trong `/mnt/d` (Windows FS):
> node_modules build trên Windows không dùng được cho Linux, và chạy trên `/mnt` rất chậm.

---

## 2. Đăng nhập ChatGPT (một lần)

```bash
cd /opt/accept-gpt
HEADLESS=false npm start
```

Cửa sổ Chromium mở ra trên Windows (nhờ WSLg), vào trang Members ở màn hình đăng nhập.
Đăng nhập tài khoản automation (nên bật MFA). Session lưu vào
`/opt/accept-gpt/data/browser-profile`, lần sau không cần đăng nhập lại.

Nếu cửa sổ không hiện, kiểm tra `echo $DISPLAY` phải ra `:0`. Nếu trống:
`export DISPLAY=:0` rồi chạy lại.

> **Lưu ý user/cache Playwright:** Playwright tải Chromium vào cache của user *đã chạy lệnh install*
> (`~/.cache/ms-playwright`). Nếu bạn chạy `wsl-setup.sh` bằng `root`/`sudo` nhưng chạy `npm start`
> bằng user thường (vd `hoanganh`), sẽ báo *"Executable doesn't exist ... chromium-1228"*.
> Cách xử lý: cài Chromium bằng đúng user chạy app (thư viện hệ thống `--with-deps` đã cài rồi nên
> không cần root nữa):
> ```bash
> cd /opt/accept-gpt && npx playwright install chromium
> ```
> Trên VPS thật: chạy toàn bộ (kể cả `npx playwright install chromium`) bằng user dịch vụ `acceptgpt`,
> chỉ dùng `sudo` cho phần `--with-deps` (cài lib hệ thống).

---

## 3. Test các kịch bản (plan mục 14.10)

Để service đang chạy (`npm start`), mở terminal WSL thứ hai:

```bash
cd /opt/accept-gpt
SECRET=$(grep ^WEBHOOK_SECRET .env | cut -d= -f2)

# Gửi webhook
curl -X POST http://127.0.0.1:8080/webhook \
  -H 'content-type: application/json' \
  -H "x-webhook-secret: $SECRET" \
  -d '{"emails":["a@example.com","b@example.com"]}'
```

Kiểm tra lần lượt:
- **Có yêu cầu chờ**: tạo 1 request pending trên workspace → gửi webhook → Telegram báo "Đã duyệt".
- **Không có yêu cầu**: không có request nào → Telegram báo "Không có yêu cầu chờ".
- **Session hết hạn**: đăng xuất ChatGPT trong cửa sổ → gửi webhook → Telegram báo hết hạn, worker dừng.
- **Nhiều webhook cùng lúc**: gửi liên tiếp nhiều request → phải xử lý tuần tự, không chạy song song.
- **Browser crash**: `pkill -f chrome` → gửi webhook → tự mở lại Chromium và xử lý.

Xem log: service in JSON ra stdout của terminal đang chạy `npm start`, và ghi vào
`/opt/accept-gpt/logs/app.log`. Screenshot lỗi ở `/opt/accept-gpt/screenshots/`.

---

## 4. (Tuỳ chọn) Chạy nền bằng systemd trong WSL

WSL này đã bật systemd. Với WSLg cần thêm `DISPLAY=:0`:

```bash
# sửa deploy/systemd/accept-gpt.service: WorkingDirectory=/opt/accept-gpt, User=root,
# và đảm bảo có dòng: Environment=DISPLAY=:0
cp /opt/accept-gpt/deploy/systemd/accept-gpt.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now accept-gpt
journalctl -u accept-gpt -f
```

> Trên WSL không cần `xvfb.service` (đã có WSLg). Trên VPS thật thì cần Xvfb — xem [../README.md](../README.md).

---

## Khác biệt WSL vs VPS thật

| | WSL (test) | VPS thật |
|---|---|---|
| Hiển thị browser | WSLg (`DISPLAY=:0`) | Xvfb `:99` |
| Đăng nhập lần đầu | Cửa sổ Chromium trên Windows | noVNC qua SSH tunnel |
| systemd | Có sẵn | Cài xvfb.service + accept-gpt.service |
| User | root | user riêng `acceptgpt` |
