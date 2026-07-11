# Dựng HTTPS reverse proxy cho AcceptGPT (Caddy + domain)

Để bên gửi bắn webhook qua Internet an toàn: đặt **Caddy** đứng trước, nhận HTTPS ở
`https://<domain>/webhook` rồi chuyển tiếp về backend `127.0.0.1:8080`.

Backend giữ nguyên `HOST=127.0.0.1` (chỉ nghe localhost) — **không** mở cổng 8080 ra Internet.

---

## 1. DNS

Tạo bản ghi **A** trỏ domain (hoặc subdomain) về **IP công khai của VPS**:

```
accept.nguyenhoanganh.dev   A   152.42.166.79
```

Chờ phân giải (thường vài phút). Kiểm tra: `dig +short accept.nguyenhoanganh.dev` phải ra `152.42.166.79`.

## 2. Mở firewall

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (Caddy cần để xin cert)
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
# KHÔNG mở 8080 ra ngoài.
```

## 3. Cài Caddy (kho apt chính thức)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 4. Đặt cấu hình

```bash
# Sửa domain trong file trước khi copy:
sudo cp /opt/accept-gpt/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # đổi accept.nguyenhoanganh.dev -> domain thật
sudo systemctl reload caddy
```

Caddy tự xin chứng chỉ Let's Encrypt ngay lần đầu (cần cổng 80/443 mở + DNS đúng).

## 5. Kiểm tra

```bash
# Từ máy bất kỳ:
curl https://accept.nguyenhoanganh.dev/health
# -> {"status":"ok","queued":0,"time":"..."}

# Thử webhook (thay secret thật):
curl -X POST https://accept.nguyenhoanganh.dev/webhook \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: <WEBHOOK_SECRET>' \
  -d '{"emails":["test@example.com"]}'
# -> 202 {"queued":true,...}
```

## 6. Bàn giao cho bên gửi

- `WEBHOOK_URL = https://accept.nguyenhoanganh.dev/webhook`
- `WEBHOOK_SECRET = ...` (lấy từ `.env` trên VPS, trao qua kênh bảo mật)

Xem hợp đồng API đầy đủ ở [../WEBHOOK-INTEGRATION.md](../WEBHOOK-INTEGRATION.md).

---

### Ghi chú
- Đổi IP VPS sau này: chỉ cần sửa bản ghi A, `WEBHOOK_URL` bên gửi giữ nguyên.
- Caddy tự gia hạn cert, không cần làm gì thêm.
- Muốn giới hạn chỉ IP bên gửi mới gọi được: thêm matcher `remote_ip` trong Caddyfile hoặc
  `sudo ufw allow from <IP-bên-gửi> to any port 443`.
