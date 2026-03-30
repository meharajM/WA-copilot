#!/usr/bin/env bash
# =============================================================================
# publish-mac.sh — Mac Release Pipeline → Cloudflare R2
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env.r2"
MAC_OUT_DIR="dist/mac-release"

# ── Load shared helpers ───────────────────────────────────────────────────────
source "$SCRIPT_DIR/bootstrap-env.sh"

clean_mac_universal_temps() {
  local out_dir="$1"
  echo "🧹 Cleaning stale mac universal temp artifacts..."
  rm -rf \
    "${out_dir}/mac-universal" \
    "${out_dir}/mac-universal-x64-temp" \
    "${out_dir}/mac-universal-arm64-temp" \
    dist/mac-universal \
    dist/mac-universal-x64-temp \
    dist/mac-universal-arm64-temp
  echo "✅ mac universal temp artifacts cleaned."
}

auto_clean_native_build_outputs() {
  echo "🧹 Cleaning native module build outputs..."
  rm -rf \
    node_modules/better-sqlite3/build
  echo "✅ Native build outputs cleaned."
}

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
BUILD_TARGET="arm64"
SKIP_CHECKS=false
SKIP_BUILD=false
STRICT_UNIVERSAL=false
AUTO_CONFIRM=false

for arg in "$@"; do
  case $arg in
    --universal)   BUILD_TARGET="universal" ;;
    --intel)       BUILD_TARGET="x64" ;;
    --strict-universal) STRICT_UNIVERSAL=true ;;
    --yes|-y) AUTO_CONFIRM=true ;;
    --skip-checks) SKIP_CHECKS=true ;;
    --skip-build)  SKIP_BUILD=true; SKIP_CHECKS=true ;;
  esac
done

if [ "$BUILD_TARGET" = "universal" ] && [ "$(uname -m)" = "arm64" ]; then
  if ! ensure_x64_node_runtime "$ROOT_DIR"; then
    if [ "$STRICT_UNIVERSAL" = true ]; then
      echo "❌ Mac universal build requires an x64 Node runtime."
      exit 1
    fi
    echo "⚠️ Falling back to arm64 Mac build (x64 Node missing)."
    BUILD_TARGET="arm64"
  fi
fi

# ── Confirmation prompt ───────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ⚠️   WA-Co-Pilot Mac PRODUCTION RELEASE WARNING      ║"
echo "║                                                      ║"
echo "║  Version : v${VERSION}                                   ║"
echo "║  Bucket  : ${R2_BUCKET_NAME}"
echo "║  Target  : macOS (${BUILD_TARGET})"
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
  npm run lint && npm run typecheck
fi

# Step 2: Build + Package
if [ "$SKIP_BUILD" = false ]; then
  npm run prebuild:electron
  npm run build
  rm -rf "${MAC_OUT_DIR}"
  mkdir -p "${MAC_OUT_DIR}"
  if [ "$BUILD_TARGET" = "universal" ]; then
    auto_clean_native_build_outputs
    clean_mac_universal_temps "$MAC_OUT_DIR"
  fi
  npx electron-builder --mac "--${BUILD_TARGET}" --config.directories.output="${MAC_OUT_DIR}"
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
      local filename=$(basename "$file")
      echo "  ↑ $filename"
      aws s3 rm "${R2}/$filename" $ENDPOINT 2>/dev/null || true
      aws s3 cp "$file" "${R2}/$filename" $ENDPOINT
    done
  done
}

UPLOAD_DIR="${MAC_OUT_DIR}"
[ "$SKIP_BUILD" = true ] && [ ! -d "${UPLOAD_DIR}" ] && UPLOAD_DIR="dist"

shopt -s nullglob
upload_artifacts "${UPLOAD_DIR}" "*.dmg" "*.zip" "*.blockmap" "latest*.yml"
shopt -u nullglob
aws s3 rm "${R2}/aica-install-mac.sh" $ENDPOINT 2>/dev/null || true
aws s3 cp "scripts/aica-install-mac.sh" "${R2}/aica-install-mac.sh" $ENDPOINT

echo "✅ Done!"
