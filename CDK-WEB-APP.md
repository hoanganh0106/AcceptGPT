# CDK Web App vận hành trên VPS

## Chuẩn bị Supabase

Áp dụng `supabase/migrations/202607140001_cdk_invite.sql` trong Supabase
Dashboard hoặc CLI đã xác thực trước khi bật các route tạo CDK. Kiểm tra rằng
RLS đã bật, không có policy cho browser, và `consume_cdk` chỉ được gọi bởi
backend role. Backend cần outbound HTTPS tới Supabase.

Tạo một key mới có dạng `sb_secret_...`. Chỉ đặt `SUPABASE_URL` và
`SUPABASE_SECRET_KEY` trong file `.env` được bảo vệ trên VPS. Tạo riêng
`ADMIN_SESSION_SECRET` và `CDK_HASH_SECRET` bằng trình tạo random an toàn; không
đưa chúng vào chat, Git, command line, HTML, JSON hay log.

## Cấu hình và triển khai

```bash
cd /opt/accept-gpt
sudo -u acceptgpt npm ci --no-audit --no-fund
sudo -u acceptgpt npm run build
```

Không tạo `.env` bằng script setup. Điền các biến theo `.env.example` bằng kênh
bảo mật, sau đó dùng systemd hiện có. Node.js 24 LTS là baseline; không cài
SQLite, local Postgres hay native database package.

Trước khi phát CDK, đăng nhập admin, cập nhật `invite_workspace_id`, rồi mở
Playwright thủ công đúng workspace đó. Cảnh báo luôn hiển thị cạnh cả hai
control: **“Hãy bảo đảm Playwright đang ở đúng workspace trước khi phát CDK.”**

Mỗi CDK được hiển thị plaintext đúng một lần. CDK không hết hạn, không có route
thu hồi, hoàn tiền, kích hoạt lại hoặc xóa. History chỉ hiển thị hash-free
metadata và kết quả an toàn. `used/processing` còn sót sau restart được đổi sang
`service_interrupted`, không bao giờ quay về `unused`.

Xoay `SUPABASE_SECRET_KEY` không làm CDK mất hiệu lực. Xoay
`CDK_HASH_SECRET` làm các CDK cũ không thể xác thực, vì vậy chỉ xoay secret đó
khi đã có kế hoạch phát lại toàn bộ code.

## Kiểm tra không tiết lộ secret

```bash
systemctl is-active accept-gpt
curl -fsS https://nguyenhoanganh.dev/health
curl -fsSI https://nguyenhoanganh.dev/
curl -fsSI https://nguyenhoanganh.dev/admin
journalctl -u accept-gpt -n 100 --no-pager
```

Không đặt CDK, password, session hoặc secret trong URL. Caddy chỉ proxy các
route được allowlist trong `deploy/Caddyfile`. Rollback giữ nguyên toàn bộ row
Supabase và tuyệt đối không reset code đã `used`; backup/retention do Supabase
project quản lý, không có SQLite/WAL backup step.

`gptk12.txt` chỉ là tài liệu nghiên cứu cho candidate-side ChatGPT calls, không
được serve cho browser và không phải runtime credential store.
