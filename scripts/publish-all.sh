#!/usr/bin/env bash
# =============================================================================
# publish-all.sh — Full Release Pipeline (All Platforms → Cloudflare R2)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env.r2"
DIST_ROOT="dist"
MAC_OUT_DIR="${DIST_ROOT}/mac-release"
LINUX_OUT_DIR="${DIST_ROOT}/linux-release"
WIN_OUT_DIR="${DIST_ROOT}/win-release"

# ── Load shared helper ───────────────────────────────────────────────────────
source "$SCRIPT_DIR/bootstrap-env.sh"

auto_clean_native_build_outputs() {
  echo "🧹 Cleaning native module build outputs..."
  rm -rf \
    node_modules/better-sqlite3/build \
    node_modules/bufferutil/build \
    node_modules/utf-8-validate/build
  echo "✅ Native build outputs cleaned."
}

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

reset_output_dir() {
  local out_dir="$1"
  rm -rf "${out_dir}"
  mkdir -p "${out_dir}"
}

retry_aws_cp() {
  local src="$1"
  local dst="$2"
  local max_attempts=5
  local attempt=1
  local backoff=5

  until aws s3 cp "$src" "$dst" $ENDPOINT --no-progress; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "❌ Upload failed after ${max_attempts} attempts: ${src}"
      return 1
    fi
    echo "⚠️ Upload failed (attempt ${attempt}/${max_attempts}): ${src}"
    echo "   Retrying in ${backoff}s..."
    sleep "$backoff"
    attempt=$((attempt + 1))
    backoff=$((backoff * 2))
  done
}

upload_artifacts() {
  local source_dir="$1"
  shift
  local pattern
  local file
  local found=false

  shopt -s nullglob
  for pattern in "$@"; do
    for file in "${source_dir}"/${pattern}; do
      found=true
      retry_aws_cp "$file" "${R2}/$(basename "$file")"
    done
  done
  shopt -u nullglob

  if [ "$found" = false ]; then
    echo "⚠️ No artifacts matched in ${source_dir} for patterns: $*"
    return 1
  fi
}

upload_latest_manifests() {
  local source_dir="$1"
  if [ -d "$source_dir" ]; then
    local manifest
    local found=false
    shopt -s nullglob
    for manifest in "${source_dir}"/latest*.yml; do
      found=true
      retry_aws_cp "$manifest" "${R2}/$(basename "$manifest")"
    done
    shopt -u nullglob

    if [ "$found" = false ]; then
      echo "⚠️ No updater manifests found in ${source_dir}."
    fi
  fi
}

# ── Load R2 credentials ───────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Missing credentials file: .env.r2"
  echo "   Create .env.r2 with your Cloudflare R2 credentials."
  echo "   R2_BUCKET_NAME=..."
  echo "   R2_ACCESS_KEY_ID=..."
  echo "   R2_SECRET_ACCESS_KEY=..."
  echo "   R2_ENDPOINT_URL=..."
  exit 1
fi
set -a; source "$ENV_FILE"; set +a

# ── Parse args ────────────────────────────────────────────────────────────────
BUILD_MAC=true; BUILD_LINUX=true; BUILD_WIN=true
SKIP_CHECKS=false; SKIP_BUILD=false; MAC_ARCH="universal"; STRICT_UNIVERSAL=false; AUTO_CONFIRM=false

for arg in "$@"; do
  case $arg in
    --mac-only)   BUILD_LINUX=false; BUILD_WIN=false ;;
    --linux-only) BUILD_MAC=false; BUILD_WIN=false ;;
    --win-only)   BUILD_MAC=false; BUILD_LINUX=false ;;
    --arm64)      MAC_ARCH="arm64" ;;
    --intel)      MAC_ARCH="x64" ;;
    --universal)      MAC_ARCH="universal" ;;
    --strict-universal) STRICT_UNIVERSAL=true ;;
    --yes|-y) AUTO_CONFIRM=true ;;
    --skip-checks) echo "--skip-checks is disabled for production publishing"; exit 1 ;;
    --skip-build)  SKIP_BUILD=true ;;
  esac
done

# Universal Mac check
if [ "$BUILD_MAC" = true ] && [ "$MAC_ARCH" = "universal" ] && [ "$(uname -m)" = "arm64" ]; then
  if ! ensure_x64_node_runtime "$ROOT_DIR"; then
    if [ "$STRICT_UNIVERSAL" = true ]; then
      echo "❌ Mac universal build requires x64 Node. Check bootstrap-env.sh for details."
      exit 1
    fi
    echo "⚠️ Falling back to arm64 Mac build (x64 Node missing)."
    MAC_ARCH="arm64"
  fi
fi

# ── Confirmation prompt ───────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ⚠️   WA-Co-Pilot PRODUCTION RELEASE WARNING          ║"
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
else
  echo "  Auto-confirm enabled. Continuing..."
fi

# ── Step 0: Ensure dependencies ────────────────────────────────────────────────
check_dependencies false false

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_EC2_METADATA_DISABLED=true

cd "$ROOT_DIR"

# ── Step 1: Quality checks ────────────────────────────────────────────────────
if [ "$SKIP_CHECKS" = false ]; then
  echo "🔍 [1/4] Running release gate..."
  "$SCRIPT_DIR/release-gate.sh"
fi

# ── Step 2: Build JS bundle ───────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "🔧 [2/4] Building JS bundle..."
  npm run prebuild:electron
  npm run build
fi

# ── Step 3: Package all platforms ────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "📦 [3/4] Packaging platforms..."
  [ "$BUILD_MAC" = true ]   && (
    echo "🍎 Packaging Mac (${MAC_ARCH})..."
    reset_output_dir "$MAC_OUT_DIR"
    if [ "$MAC_ARCH" = "universal" ]; then
      auto_clean_native_build_outputs
      clean_mac_universal_temps "$MAC_OUT_DIR"
    fi
    npx electron-builder --mac --${MAC_ARCH} \
      --config.forceCodeSigning=true \
      --config.mac.notarize=true \
      --config.directories.output="${MAC_OUT_DIR}"
    APP_PATH=$(find "${MAC_OUT_DIR}" -maxdepth 2 -type d -name '*.app' -print -quit)
    DMG_PATH=$(find "${MAC_OUT_DIR}" -maxdepth 1 -type f -name '*.dmg' -print -quit)
    "$SCRIPT_DIR/verify-macos-release.sh" "$APP_PATH" "$DMG_PATH"
    "$SCRIPT_DIR/write-release-checksums.sh" "${MAC_OUT_DIR}"
  )
  [ "$BUILD_LINUX" = true ] && (
    echo "🐧 Packaging Linux..."
    reset_output_dir "$LINUX_OUT_DIR"
    npx electron-builder --linux --x64 --arm64 --config.directories.output="${LINUX_OUT_DIR}"
    "$SCRIPT_DIR/write-release-checksums.sh" "${LINUX_OUT_DIR}"
  )
  [ "$BUILD_WIN" = true ]   && (
    echo "🪟 Packaging Windows..."
    reset_output_dir "$WIN_OUT_DIR"
    npx electron-builder --win --x64 \
      --config.forceCodeSigning=true \
      --config.directories.output="${WIN_OUT_DIR}"
    "$SCRIPT_DIR/write-release-checksums.sh" "${WIN_OUT_DIR}"
  )
fi

# ── Step 4: Upload to R2 ──────────────────────────────────────────────────────
echo "☁️  [4/4] Uploading to R2..."
R2="s3://${R2_BUCKET_NAME}"
ENDPOINT="--endpoint-url ${R2_ENDPOINT_URL}"
UPLOAD_PIDS=()

[ "$BUILD_MAC" = true ] && (
  upload_artifacts "${MAC_OUT_DIR}" "*.dmg" "*.zip" "*.blockmap" "SHA256SUMS"
  retry_aws_cp "scripts/install-mac.sh" "${R2}/install-mac.sh"
) &
[ "$BUILD_MAC" = true ] && UPLOAD_PIDS+=($!)

[ "$BUILD_LINUX" = true ] && (
  upload_artifacts "${LINUX_OUT_DIR}" "*.AppImage" "*.deb" "*.blockmap" "SHA256SUMS"
  retry_aws_cp "scripts/install-linux.sh" "${R2}/install-linux.sh"
) &
[ "$BUILD_LINUX" = true ] && UPLOAD_PIDS+=($!)

[ "$BUILD_WIN" = true ] && (
  upload_artifacts "${WIN_OUT_DIR}" "*.exe" "*.blockmap" "SHA256SUMS"
  retry_aws_cp "scripts/install-windows.ps1" "${R2}/install-windows.ps1"
) &
[ "$BUILD_WIN" = true ] && UPLOAD_PIDS+=($!)

for pid in "${UPLOAD_PIDS[@]}"; do
  wait "$pid"
done

# Manifests
[ "$BUILD_MAC" = true ] && upload_latest_manifests "$MAC_OUT_DIR"
[ "$BUILD_LINUX" = true ] && upload_latest_manifests "$LINUX_OUT_DIR"
[ "$BUILD_WIN" = true ] && upload_latest_manifests "$WIN_OUT_DIR"

echo "✅ Done!"
