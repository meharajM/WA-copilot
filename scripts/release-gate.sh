#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

if [ "${RELEASE_ALLOW_DIRTY:-false}" != "true" ] && [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "Release gate failed: tracked or untracked changes are present."
  echo "Commit the reviewed release candidate before publishing."
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
LOCK_VERSION="$(node -p "require('./package-lock.json').version")"
if [ "$VERSION" != "$LOCK_VERSION" ]; then
  echo "Release gate failed: package.json ($VERSION) and package-lock.json ($LOCK_VERSION) versions differ."
  exit 1
fi

if [ "$VERSION" = "1.0.0" ]; then
  echo "Release gate failed: version 1.0.0 already has published artifacts. Bump the version first."
  exit 1
fi

git diff --check
npm run lint
npm run typecheck
npm run typecheck:renderer
npm run test:unit
npm run test:integration
npm run test:agentd:speech
npm run test:relay
npm run check:windows-resource-evidence
node --test tests/unit/tauri-agentd-packaging.test.cjs
npm run test:e2e
npm run test:e2e:browser
npm run build

echo "Release gate passed for v${VERSION}."
