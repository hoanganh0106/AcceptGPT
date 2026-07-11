#!/usr/bin/env bash
# Gửi webhook test tới service đang chạy cục bộ.
# Dùng: bash deploy/send-test-webhook.sh [email]
set -euo pipefail

cd /opt/accept-gpt
SECRET=$(grep -E '^WEBHOOK_SECRET=' .env | cut -d= -f2-)
EMAIL="${1:-hoanganhc418@gmail.com}"

echo "POST http://127.0.0.1:8080/webhook  email=$EMAIL"
curl -s -o /dev/null -w "HTTP status: %{http_code}\n" \
  -X POST http://127.0.0.1:8080/webhook \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $SECRET" \
  -d "{\"emails\":[\"$EMAIL\"]}"
