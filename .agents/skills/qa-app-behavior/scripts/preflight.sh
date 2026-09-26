#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT_DIR"

echo "[preflight] repo: $ROOT_DIR"

echo "[preflight] npm run typecheck"
npm run typecheck

echo "[preflight] npm run test:unit"
npm run test:unit

echo "[preflight] npm run test:integration"
npm run test:integration

echo "[preflight] npm run build"
npm run build

if node -e "const p=require('./package.json'); process.exit(p.scripts?.['build:tauri:web'] ? 0 : 1)"; then
  echo "[preflight] npm run build:tauri:web"
  npm run build:tauri:web
  test -f "dist/tauri.html"
  echo "[preflight] browser bundle found: dist/tauri.html"
elif [[ -d "out" ]]; then
  echo "[preflight] browser build script unavailable; legacy renderer output found: out"
else
  echo "[preflight] no browser build output found"
  exit 1
fi

echo "[preflight] behavior contract check"
if [[ ! -f "docs/app-behavior.md" ]]; then
  echo "[preflight] missing docs/app-behavior.md"
  exit 1
fi

echo "[preflight] complete"
