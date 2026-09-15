#!/usr/bin/env bash
# =============================================================================
# publish-win.sh — Windows Release Pipeline → Cloudflare R2
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env.r2"
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
SKIP_CHECKS=false
SKIP_BUILD=false
AUTO_CONFIRM=false

for arg in "$@"; do
  case $arg in
    --yes|-y) AUTO_CONFIRM=true ;;
    --skip-checks) echo "--skip-checks is disabled for production publishing"; exit 1 ;;
    --skip-build)  SKIP_BUILD=true ;;
  esac
done

# ── Confirmation prompt ───────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ⚠️   WA-Co-Pilot Windows PRODUCTION RELEASE WARNING   ║"
echo "║                                                      ║"
echo "║  Version : v${VERSION}                                   ║"
echo "║  Bucket  : ${R2_BUCKET_NAME}"
echo "║  Target  : Windows (x64)                             ║"
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

# Step 1: Quality checks
if [ "$SKIP_CHECKS" = false ]; then
  "$SCRIPT_DIR/release-gate.sh"
fi

# Step 2: Build + Package
if [ "$SKIP_BUILD" = false ]; then
  npm run prebuild:electron
  npm run build
  rm -rf "${WIN_OUT_DIR}"
  mkdir -p "${WIN_OUT_DIR}"
  npx electron-builder --win --x64 \
    --config.forceCodeSigning=true \
    --config.directories.output="${WIN_OUT_DIR}"
fi

"$SCRIPT_DIR/write-release-checksums.sh" "${WIN_OUT_DIR}"

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

UPLOAD_DIR="${WIN_OUT_DIR}"

shopt -s nullglob
upload_artifacts "${UPLOAD_DIR}" "*.exe" "*.blockmap" "latest.yml" "SHA256SUMS"
shopt -u nullglob
aws s3 cp "scripts/install-windows.ps1" "${R2}/install-windows.ps1" $ENDPOINT

echo "✅ Done!"
