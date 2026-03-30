#!/usr/bin/env bash
# =============================================================================
# publish-linux-win.sh — Linux & Windows Release Pipeline → Cloudflare R2
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env.r2"
LINUX_OUT_DIR="dist/linux-release"
WIN_OUT_DIR="dist/win-release"

# ── Load R2 credentials ───────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Missing credentials file: .env.r2"
  exit 1
fi
set -a; source "$ENV_FILE"; set +a

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_EC2_METADATA_DISABLED=true

# ── Parse args ────────────────────────────────────────────────────────────────
BUILD_LINUX=true
BUILD_WIN=true
SKIP_CHECKS=false
SKIP_BUILD=false
AUTO_CONFIRM=false

for arg in "$@"; do
  case $arg in
    --linux-only)  BUILD_WIN=false ;;
    --win-only)    BUILD_LINUX=false ;;
    --yes|-y) AUTO_CONFIRM=true ;;
    --skip-checks) SKIP_CHECKS=true ;;
    --skip-build)  SKIP_BUILD=true; SKIP_CHECKS=true ;;
  esac
done

# ── Confirmation prompt ───────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ⚠️   WA-Co-Pilot Linux/Win PRODUCTION RELEASE WARNING ║"
echo "║                                                      ║"
echo "║  Version : v${VERSION}                                   ║"
echo "║  Bucket  : ${R2_BUCKET_NAME}"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
if [ "$AUTO_CONFIRM" = false ]; then
  read -r -p "  Type 'yes' to confirm and publish: " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "❌ Aborted."
    exit 0
  fi
fi

cd "$ROOT_DIR"

# Docker check
if [ "$SKIP_BUILD" = false ] && [ "$BUILD_LINUX" = true ]; then
  if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker not running. Required for Linux builds."
    exit 1
  fi
fi

# Step 1: Quality checks
if [ "$SKIP_CHECKS" = false ]; then
  npm run lint && npm run typecheck
fi

# Step 2: Build + Package
if [ "$SKIP_BUILD" = false ]; then
  npm run prebuild:electron
  npm run build
  if [ "$BUILD_LINUX" = true ]; then
    rm -rf "${LINUX_OUT_DIR}"
    mkdir -p "${LINUX_OUT_DIR}"
    npx electron-builder --linux --x64 --arm64 --config.directories.output="${LINUX_OUT_DIR}"
  fi
  if [ "$BUILD_WIN" = true ]; then
    rm -rf "${WIN_OUT_DIR}"
    mkdir -p "${WIN_OUT_DIR}"
    npx electron-builder --win --x64 --config.directories.output="${WIN_OUT_DIR}"
  fi
fi

# Step 3: Upload
R2="s3://${R2_BUCKET_NAME}"
ENDPOINT="--endpoint-url ${R2_ENDPOINT_URL}"

upload_artifacts() {
  local source_dir="$1"
  shift
  local pattern
  for pattern in "$@"; do
    for file in "${source_dir}"/${pattern}; do
      aws s3 cp "$file" "${R2}/$(basename "$file")" $ENDPOINT
    done
  done
}

if [ "$BUILD_LINUX" = true ]; then
  UPLOAD_DIR="${LINUX_OUT_DIR}"
  [ "$SKIP_BUILD" = true ] && [ ! -d "${UPLOAD_DIR}" ] && UPLOAD_DIR="dist"
  shopt -s nullglob
  upload_artifacts "${UPLOAD_DIR}" "*.AppImage" "*.deb" "*.blockmap" "latest*.yml"
  shopt -u nullglob
  aws s3 cp "scripts/install-linux.sh" "${R2}/install-linux.sh" $ENDPOINT
fi

if [ "$BUILD_WIN" = true ]; then
  UPLOAD_DIR="${WIN_OUT_DIR}"
  [ "$SKIP_BUILD" = true ] && [ ! -d "${UPLOAD_DIR}" ] && UPLOAD_DIR="dist"
  shopt -s nullglob
  upload_artifacts "${UPLOAD_DIR}" "*.exe" "*.blockmap" "latest*.yml"
  shopt -u nullglob
  aws s3 cp "scripts/install-windows.ps1" "${R2}/install-windows.ps1" $ENDPOINT
fi

echo "✅ Done!"
