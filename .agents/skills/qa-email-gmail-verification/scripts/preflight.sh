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

echo "[preflight] build artifact check"
if [[ -d "/Applications/AIConsumerAgent.app" ]]; then
  echo "[preflight] installed app found: /Applications/AIConsumerAgent.app"
elif [[ -d "dist/mac-arm64/AIConsumerAgent.app" ]]; then
  echo "[preflight] local build found: dist/mac-arm64/AIConsumerAgent.app"
else
  echo "[preflight] app bundle missing"
  exit 1
fi

echo "[preflight] Gmail OAuth env check"
oauth_id_state="missing"
oauth_secret_state="missing"

if [[ -n "${GMAIL_OAUTH_CLIENT_ID:-}" ]]; then
  oauth_id_state="shell-env"
elif grep -Eq '^GMAIL_OAUTH_CLIENT_ID=.+' .env 2>/dev/null; then
  oauth_id_state="repo-env"
fi

if [[ -n "${GMAIL_OAUTH_CLIENT_SECRET:-}" ]]; then
  oauth_secret_state="shell-env"
elif grep -Eq '^GMAIL_OAUTH_CLIENT_SECRET=.+' .env 2>/dev/null; then
  oauth_secret_state="repo-env"
fi

echo "[preflight] GMAIL_OAUTH_CLIENT_ID: $oauth_id_state"
echo "[preflight] GMAIL_OAUTH_CLIENT_SECRET: $oauth_secret_state"

if [[ "$oauth_id_state" == "missing" || "$oauth_secret_state" == "missing" ]]; then
  echo "[preflight] OAuth is not fully configured; keep Gmail in app-password mode for the main QA path or relaunch the app with env vars if you need to test Google sign-in."
else
  echo "[preflight] OAuth configuration appears present, but app-password mode remains the recommended client-side default."
fi

echo "[preflight] complete"
