# AIConsumerAgent - Dependency Setup Script (Windows)
# This script installs Node.js, Python, and uv for MCP server support

Write-Host "🚀 AIConsumerAgent - Setting up dependencies for Windows..." -ForegroundColor Cyan
Write-Host ""
$ErrorActionPreference = "Stop"

# Function to check if a command exists
function Test-CommandExists {
    param($command)
    return $null -ne (Get-Command $command -ErrorAction SilentlyContinue)
}

# Function to check if running as Administrator
function Test-Administrator {
    $currentUser = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentUser.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

try {
# Check for admin privileges
if (-not (Test-Administrator)) {
    Write-Host "⚠️  Administrator privileges are required. Relaunching elevated PowerShell..." -ForegroundColor Yellow
    $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $scriptPath
    )
    exit 0
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

# Check for Chocolatey (package manager for Windows)
$hasChoco = Test-CommandExists choco

if (-not $hasChoco) {
    Write-Host "📦 Installing Chocolatey (Windows package manager)..." -ForegroundColor Yellow
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    
    # Refresh environment
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "✅ Chocolatey already installed" -ForegroundColor Green
}

# Install Node.js
if (-not (Test-CommandExists node)) {
    Write-Host "📦 Installing Node.js..." -ForegroundColor Yellow
    choco install nodejs -y
} else {
    $nodeVersion = node --version
    Write-Host "✅ Node.js already installed ($nodeVersion)" -ForegroundColor Green
}

# Install Python
if (-not (Test-CommandExists python)) {
    Write-Host "📦 Installing Python 3..." -ForegroundColor Yellow
    choco install python -y
} else {
    $pythonVersion = python --version
    Write-Host "✅ Python already installed ($pythonVersion)" -ForegroundColor Green
}

# Refresh environment variables so Python/pip are available if just installed
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Install uv
if (-not (Test-CommandExists uv)) {
    Write-Host "📦 Installing uv (Python package runner)..." -ForegroundColor Yellow
    # Using python -m pip to ensure it calls the globally installed Python
    python -m pip install uv
} else {
    $uvVersion = uv --version
    Write-Host "✅ uv already installed ($uvVersion)" -ForegroundColor Green
}

# Install ffmpeg
if (-not (Test-CommandExists ffmpeg)) {
    Write-Host "📦 Installing ffmpeg (required for audio processing)..." -ForegroundColor Yellow
    choco install ffmpeg -y
} else {
    Write-Host "✅ ffmpeg already installed" -ForegroundColor Green
}

# Refresh environment variables to ensure new tools are in PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Install Playwright browsers if missing
Write-Host "📦 Ensuring Playwright browser binaries are installed..." -ForegroundColor Yellow
if (Test-CommandExists npx) {
    try {
        npx --yes playwright install
    } catch {
        Write-Host "⚠️  Could not install Playwright browsers automatically. This may be handled later." -ForegroundColor Gray
    }
} else {
    Write-Host "⚠️  npx is not available yet, skipping Playwright browser install." -ForegroundColor Gray
}

# Pre-cache MarkItDown with ALL extras
Write-Host "📦 Pre-installing markitdown with all extras (pdf/docx/audio support)..." -ForegroundColor Yellow
try {
    # We use --help as a way to trigger the download/cache of the tool
    try { 
        uvx --with "markitdown[all]" markitdown-mcp --help 
    } catch { 
        Write-Host "⚠️  Attempt 1 with uvx failed: $_" -ForegroundColor Gray
    }
} catch {
    Write-Host "⚠️  Could not pre-install markitdown automatically. This will happen on first use." -ForegroundColor Gray
}

Write-Host ""
Write-Host "✅ All dependencies installed successfully!" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "🎉 YOU'RE ALL SET! " -ForegroundColor Green
Write-Host ""
Write-Host "🛑 PLEASE CLOSE THIS TERMINAL WINDOW TO CONTINUE." -ForegroundColor Yellow
Write-Host "   The AIConsumerAgent app will automatically detect these changes" -ForegroundColor Yellow
Write-Host "   and dismiss the setup screen." -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan
} catch {
    Write-Host ""
    Write-Host "❌ A CRITICAL ERROR OCCURRED: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Red
    Write-Host "Check the error message above for details." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to exit"
