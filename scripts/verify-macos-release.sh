#!/usr/bin/env bash

set -euo pipefail

APP_PATH="${1:-}"
DMG_PATH="${2:-}"

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "Usage: $0 /path/to/App.app [/path/to/installer.dmg]"
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP_PATH"

SIGNING_INFO="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
if ! grep -q "Authority=Developer ID Application" <<<"$SIGNING_INFO"; then
  echo "Release verification failed: app is not signed with Developer ID Application."
  exit 1
fi
if ! grep -q "flags=.*runtime" <<<"$SIGNING_INFO"; then
  echo "Release verification failed: hardened runtime is not enabled."
  exit 1
fi

spctl --assess --type execute --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"

if [ -n "$DMG_PATH" ]; then
  if [ ! -f "$DMG_PATH" ]; then
    echo "Release verification failed: DMG not found at $DMG_PATH."
    exit 1
  fi
  hdiutil verify "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
fi

echo "macOS release verification passed."
