#!/usr/bin/env bash
# ==========================================================================
# Cài đặt AcceptGPT trong WSL Ubuntu (hoặc VPS Ubuntu).
# Chạy trong WSL:
#     bash /mnt/d/Du_an/AcceptGPT/deploy/wsl-setup.sh
# (Trên VPS: đổi SRC cho đúng, hoặc chạy trực tiếp trong thư mục project.)
#
# Idempotent: chạy lại nhiều lần không sao.
# Yêu cầu quyền root (WSL mặc định là root; VPS thì thêm sudo).
# ==========================================================================
set -euo pipefail

SRC="${SRC:-/mnt/d/Du_an/AcceptGPT}"
DEST="${DEST:-/opt/accept-gpt}"

echo "==> [1/6] Kiểm tra Node.js"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  case "$(node -v)" in v18*|v20*|v22*) NODE_OK=1 ;; esac
fi
if [ "$NODE_OK" -ne 1 ]; then
  echo "    Cài Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> [2/6] Copy project sang $DEST (bỏ node_modules/dist/data/logs)"
mkdir -p "$DEST"
rsync -a \
  --exclude node_modules --exclude dist --exclude '.git' \
  --exclude data --exclude logs --exclude screenshots \
  "$SRC/" "$DEST/"

cd "$DEST"

echo "==> [3/6] npm install"
npm install --no-audit --no-fund

echo "==> [4/6] Playwright Chromium + thư viện hệ thống (có thể mất vài phút)"
npx playwright install --with-deps chromium

echo "==> [5/6] Build TypeScript"
npm run build

echo "==> [6/6] Xong."
cat <<EOF

Tiếp theo:
  1) Đăng nhập ChatGPT (cửa sổ Chromium hiện qua WSLg trên Windows):
       cd $DEST
       HEADLESS=false npm start
     -> trang Members mở ra ở màn hình login; đăng nhập tài khoản automation.
     -> session được lưu vào $DEST/data/browser-profile (chỉ cần làm 1 lần).

  2) Gửi thử webhook (mở terminal WSL khác):
       curl -X POST http://127.0.0.1:8080/webhook \\
         -H 'content-type: application/json' \\
         -H 'x-webhook-secret: '"\$(grep ^WEBHOOK_SECRET .env | cut -d= -f2)" \\
         -d '{"emails":["test@example.com"]}'

  3) Kiểm tra Telegram nhận được thông báo.
EOF
