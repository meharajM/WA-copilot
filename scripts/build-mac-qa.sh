#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' \
  | head -1)

if [ -z "$IDENTITY" ]; then
  echo "Local macOS QA packaging requires an Apple Development signing identity."
  exit 1
fi

npm run prebuild:electron
npm run build
rm -rf dist/qa-mac

CSC_NAME="$IDENTITY" npx electron-builder --mac --arm64 --dir \
  --config.directories.output=dist/qa-mac

codesign --verify --deep --strict --verbose=2 dist/qa-mac/mac-arm64/AIConsumerAgent.app
echo "Local macOS QA bundle ready: dist/qa-mac/mac-arm64/AIConsumerAgent.app"
