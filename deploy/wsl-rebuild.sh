#!/usr/bin/env bash
# Dừng service đang chạy, đồng bộ src mới nhất, build lại.
# Chạy: bash deploy/wsl-rebuild.sh
set -euo pipefail

pkill -f 'dist/main.js' 2>/dev/null || true
sleep 1
rsync -a /mnt/d/Du_an/AcceptGPT/src/ /opt/accept-gpt/src/
cp -f /mnt/d/Du_an/AcceptGPT/.env /opt/accept-gpt/.env
cd /opt/accept-gpt
npm run build
echo REBUILD_DONE
