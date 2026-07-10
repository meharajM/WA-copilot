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

echo "[preflight] app artifact check"
if [[ -d "/Applications/AIConsumerAgent.app" ]]; then
  echo "[preflight] installed app found: /Applications/AIConsumerAgent.app"
elif [[ -d "dist/mac-arm64/AIConsumerAgent.app" ]]; then
  echo "[preflight] local build found: dist/mac-arm64/AIConsumerAgent.app"
elif [[ -d "out" ]]; then
  echo "[preflight] renderer/main build output found: out"
else
  echo "[preflight] no install or build artifact found"
  exit 1
fi

echo "[preflight] behavior contract check"
if [[ ! -f "docs/app-behavior.md" ]]; then
  echo "[preflight] missing docs/app-behavior.md"
  exit 1
fi

echo "[preflight] complete"
