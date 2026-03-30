#!/bin/bash
# AIConsumerAgent Unified Build Script
# Builds for both macOS and Windows architectures from a Mac host.

set -e

# Load version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "🚀 Building AIConsumerAgent v$VERSION..."

# 1. Clean and Build resources
echo "🧹 Cleaning and building resources..."
npm run prebuild:electron
npm run clean
npm run build

# 2. Build for macOS (Universal)
echo "🍎 Building macOS Universal (arm64 + x64)..."
npm run clean:native:build
npx electron-builder --mac --universal

# 3. Check for Wine and Build for Windows
echo "🪟 Checking Wine for Windows build..."
if ./install_build_deps.sh; then
    echo "🏗️ Building Windows executable (x64)..."
    npx electron-builder --win --x64
else
    echo "⚠️ Wine not found or failed to install. Skipping Windows build."
fi


echo ""
echo "✅ Build process complete! Check the 'dist' directory for outputs."
ls -lh dist/*.dmg dist/*.exe 2>/dev/null || true
