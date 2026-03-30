#!/bin/bash

# Detect OS
OS_TYPE="$(uname -s)"
echo "📍 Detected platform: $OS_TYPE"

install_linux_wine() {
    echo "Checking for Wine installation on Linux..."
    if ! command -v wine &> /dev/null; then
        echo "Wine is not installed. Wine is required to build Windows applications on Linux."
        echo "Attempting to install Wine..."
        
        # Check for package manager
        if command -v apt-get &> /dev/null; then
            echo "Detected apt-get. Installing Wine..."
            sudo dpkg --add-architecture i386
            sudo apt-get update
            sudo apt-get install -y wine64 wine32
        elif command -v dnf &> /dev/null; then
            echo "Detected dnf. Installing Wine..."
            sudo dnf install -y wine
        elif command -v pacman &> /dev/null; then
            echo "Detected pacman. Installing Wine..."
            sudo pacman -S --noconfirm wine
        else
            echo "Could not detect package manager. Please install Wine manually."
            exit 1
        fi
    else
        echo "✅ Wine is already installed."
    fi
}

install_mac_wine() {
    echo "Checking for Wine installation on macOS..."
    if ! command -v wine &> /dev/null; then
        echo "Wine is not installed. Wine is required to build Windows applications on macOS."
        
        if command -v brew &> /dev/null; then
            echo "Detected Homebrew. Installing Wine..."
            brew install --cask wine-stable
        else
            echo "❌ Homebrew not found. Please install Homebrew first, or install Wine manually."
            exit 1
        fi
    else
        echo "✅ Wine is already installed."
    fi
}

# Main logic
if [[ "$OS_TYPE" == "Linux" ]]; then
    install_linux_wine
elif [[ "$OS_TYPE" == "Darwin" ]]; then
    install_mac_wine
else
    echo "❌ This script is intended for Linux or macOS systems. Detected: $OS_TYPE"
    exit 1
fi

echo "Wine installation check complete. You should be able to build for Windows now."

