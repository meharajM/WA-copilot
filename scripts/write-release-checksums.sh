#!/usr/bin/env bash

set -euo pipefail

OUTPUT_DIR="${1:-}"
if [ -z "$OUTPUT_DIR" ] || [ ! -d "$OUTPUT_DIR" ]; then
  echo "Usage: $0 /path/to/release-output"
  exit 1
fi

cd "$OUTPUT_DIR"
FILES=$(find . -maxdepth 1 -type f ! -name 'SHA256SUMS' -print | sort)
if [ -z "$FILES" ]; then
  echo "No release artifacts found in $OUTPUT_DIR"
  exit 1
fi

: > SHA256SUMS
while IFS= read -r file; do
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" >> SHA256SUMS
  else
    shasum -a 256 "$file" >> SHA256SUMS
  fi
done <<< "$FILES"

echo "Wrote $OUTPUT_DIR/SHA256SUMS"
