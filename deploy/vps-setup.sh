#!/usr/bin/env bash
# One-shot host setup and build for an Ubuntu VPS.
# Run from any directory with: sudo bash /path/to/AcceptGPT/deploy/vps-setup.sh
set -Eeuo pipefail

readonly SWAP_TARGET_BYTES=$((2 * 1024 * 1024 * 1024))

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  die "This setup must run as root. Retry with: sudo bash ${BASH_SOURCE[0]}"
fi

[[ -r /etc/os-release ]] || die "Cannot identify the operating system (/etc/os-release is missing)."
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "Unsupported operating system '${PRETTY_NAME:-unknown}'. This script supports Ubuntu only."

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "${SCRIPT_PATH}")"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

[[ -f "${REPO_ROOT}/package.json" ]] || die "package.json was not found at the resolved repository root: ${REPO_ROOT}"
[[ -f "${REPO_ROOT}/package-lock.json" ]] || die "package-lock.json is required for npm ci: ${REPO_ROOT}"

log "[1/7] Installing base Ubuntu packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  xvfb

log "[2/7] Checking Node.js"
NODE_OK=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
  if [[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 20 )); then
    NODE_OK=1
  fi
fi

if (( NODE_OK == 0 )); then
  log "Installing Node.js 20 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

printf '    Node.js %s / npm %s\n' "$(node --version)" "$(npm --version)"

active_swap_bytes() {
  swapon --show --bytes --noheadings --output SIZE 2>/dev/null \
    | awk '{ total += $1 } END { printf "%.0f", total + 0 }'
}

swap_is_active() {
  swapon --show --noheadings --output NAME 2>/dev/null | grep -Fxq "$1"
}

swap_is_valid() {
  [[ "$(blkid -p -s TYPE -o value "$1" 2>/dev/null || true)" == "swap" ]]
}

persist_swap() {
  local swap_file="$1"
  if ! awk -v path="${swap_file}" \
    '!/^[[:space:]]*#/ && $1 == path && $3 == "swap" { found = 1 } END { exit !found }' \
    /etc/fstab; then
    printf '%s none swap sw 0 0\n' "${swap_file}" >> /etc/fstab
  fi
}

create_swap_file() {
  local swap_file="$1"
  local temp_file="${swap_file}.acceptgpt-tmp-$$"

  rm -f "${temp_file}"
  if ! fallocate -l 2G "${temp_file}"; then
    rm -f "${temp_file}"
    dd if=/dev/zero of="${temp_file}" bs=1M count=2048 status=progress
  fi
  chmod 600 "${temp_file}"
  mkswap "${temp_file}"
  mv "${temp_file}" "${swap_file}"
  swapon "${swap_file}"
  persist_swap "${swap_file}"
}

log "[3/7] Ensuring at least 2 GB of active swap"
SWAP_FILES=(/swapfile /swapfile.acceptgpt)

# Reuse and persist known swap files even when another active swap source has
# already brought the host above the target. This repairs a missing fstab entry
# on reruns without replacing or resizing any existing swap.
for SWAP_FILE in "${SWAP_FILES[@]}"; do
  if [[ ! -e "${SWAP_FILE}" ]]; then
    continue
  fi
  if ! swap_is_valid "${SWAP_FILE}"; then
    printf '    %s exists and is not swap; leaving it untouched.\n' "${SWAP_FILE}"
    continue
  fi

  chmod 600 "${SWAP_FILE}"
  if ! swap_is_active "${SWAP_FILE}"; then
    swapon "${SWAP_FILE}"
  fi
  persist_swap "${SWAP_FILE}"
done

CURRENT_SWAP_BYTES="$(active_swap_bytes)"
if (( CURRENT_SWAP_BYTES >= SWAP_TARGET_BYTES )); then
  printf '    Reusing existing active swap (%s MiB); no swap was replaced.\n' "$((CURRENT_SWAP_BYTES / 1024 / 1024))"
else
  SWAP_CREATED=0
  for SWAP_FILE in "${SWAP_FILES[@]}"; do
    if [[ -e "${SWAP_FILE}" ]]; then
      continue
    fi

    printf '    Creating a persistent 2 GB swap file at %s.\n' "${SWAP_FILE}"
    create_swap_file "${SWAP_FILE}"
    SWAP_CREATED=1
    break
  done

  (( SWAP_CREATED == 1 )) || die "Could not safely create swap: /swapfile and /swapfile.acceptgpt are already occupied."
fi

printf '    Active swap: %s MiB\n' "$(( $(active_swap_bytes) / 1024 / 1024 ))"

log "[4/7] Installing locked Node.js dependencies"
cd "${REPO_ROOT}"
npm ci --no-audit --no-fund

log "[5/7] Installing Chromium and its Ubuntu dependencies"
# Keep Chromium beside node_modules instead of in root's private cache so the
# eventual service user can execute the browser from this checkout.
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium

log "[6/7] Building AcceptGPT"
npm run build

log "[7/7] VPS setup and build completed"
cat <<EOF

Repository: ${REPO_ROOT}
Xvfb is installed, but no application or Xvfb service was enabled or started.

Next steps:
  1. Create and configure ${REPO_ROOT}/.env separately (this script never creates or overwrites it).
  2. Configure the service user/systemd units, then start the application when ready.
  3. Configure a reverse proxy separately if the service must be exposed publicly.
EOF
