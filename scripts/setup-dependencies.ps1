# AIConsumerAgent - Dependency Setup Script (Windows)
# This script installs Node.js, Python, and uv for MCP server support

# Function to check if a command exists
function Test-CommandExists {
    param($command)
    $null = Get-Command $command -ErrorAction SilentlyContinue
    return $?
}

# Function to check if running as Administrator
function Test-Administrator {
    $currentUser = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentUser.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$ErrorActionPreference = "Stop"

try {
    Write-Host "🚀 AIConsumerAgent - Setting up dependencies for Windows..." -ForegroundColor Cyan
    Write-Host ""

    # Check for admin privileges
    if (-not (Test-Administrator)) {
        Write-Host "⚠️  Administrator privileges are required. Relaunching elevated PowerShell..." -ForegroundColor Yellow
        $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
        $scriptName = Split-Path -Leaf $MyInvocation.MyCommand.Path
        $scriptPath = Join-Path $scriptRoot $scriptName
        if (-not $scriptPath) { $scriptPath = $PSCommandPath }
        
        # Use quotes to ensure paths with spaces work
        $quotedScriptPath = "`"$scriptPath`""
        
        try {
            Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
                "-NoExit",
                "-ExecutionPolicy", "Bypass",
                "-File", $quotedScriptPath
            )
        } catch {
            Write-Host "❌ Failed to relaunch with administrator privileges: $_" -ForegroundColor Red
            Read-Host "Press Enter to exit"
        }
        exit 0
    }

    # Ensure we are in the project root
    $currentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if ($currentDir) {
        $projectRoot = Split-Path -Parent $currentDir
        if ($projectRoot -and (Test-Path $projectRoot)) {
            Set-Location $projectRoot
        }
    }

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

    # Install uv
    if (-not (Test-CommandExists uv)) {
        Write-Host "📦 Installing uv (Python package runner)..." -ForegroundColor Yellow
        powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
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

    # Refresh environment variables
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

    # Install Playwright browsers if missing
    Write-Host "📦 Ensuring Playwright browser binaries are installed..." -ForegroundColor Yellow
    npx playwright install

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
    Write-Host "Please check the error message above for details." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to exit"
