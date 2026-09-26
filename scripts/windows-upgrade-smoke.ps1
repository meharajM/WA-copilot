[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PreviousInstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$CurrentInstallerPath
)

$ErrorActionPreference = 'Stop'

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Resolve-Installer([string]$Path, [string]$Label) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  Assert-Condition (Test-Path -LiteralPath $resolved -PathType Leaf) "$Label installer not found: $resolved"
  return $resolved
}

function Invoke-SilentInstall([string]$Installer, [string]$InstallRoot, [string]$Label) {
  $result = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallRoot") -Wait -PassThru
  Assert-Condition ($result.ExitCode -eq 0) "$Label installer failed with exit code $($result.ExitCode)"
}

function Find-InstalledBinary([string]$InstallRoot) {
  return Get-ChildItem -LiteralPath $InstallRoot -Filter 'aica-tauri-pilot.exe' -File -Recurse | Select-Object -First 1
}

function Stop-InstalledProcesses([string]$InstallRoot) {
  $companionPaths = @(Get-ChildItem -LiteralPath $InstallRoot -Filter 'aica-tauri-pilot.exe' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName)
  $companionProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'aica-tauri-pilot.exe'" |
    Where-Object { $_.ExecutablePath -and ($companionPaths -contains $_.ExecutablePath) } |
    Select-Object -ExpandProperty ProcessId)
  foreach ($processId in $companionProcesses) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }

  $runtimeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'agentd-runtime.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -ExpandProperty ProcessId)
  foreach ($processId in $runtimeProcesses) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
}

$previousInstaller = Resolve-Installer $PreviousInstallerPath 'Previous'
$currentInstaller = Resolve-Installer $CurrentInstallerPath 'Current'
Assert-Condition (-not $previousInstaller.Equals($currentInstaller, [System.StringComparison]::OrdinalIgnoreCase)) 'Previous and current installer paths must differ'

$smokeId = [Guid]::NewGuid().ToString('N')
$installRoot = Join-Path $env:RUNNER_TEMP "aica-upgrade-smoke-$smokeId"
$dataSentinel = Join-Path (Join-Path $env:LOCALAPPDATA 'com.aica.tauri-pilot') "upgrade-sentinel-$smokeId.txt"
$null = New-Item -ItemType Directory -Force -Path $installRoot

try {
  # Install the prior release, then upgrade to the candidate and downgrade
  # back. The same isolated install root and per-user sentinel prove that the
  # installer does not delete user data across either direction.
  Invoke-SilentInstall $previousInstaller $installRoot 'Previous'
  Assert-Condition ($null -ne (Find-InstalledBinary $installRoot)) 'Previous installer did not install the native companion'

  $dataRoot = Split-Path -Parent $dataSentinel
  $null = New-Item -ItemType Directory -Force -Path $dataRoot
  Set-Content -LiteralPath $dataSentinel -Value "upgrade-sentinel-$smokeId" -NoNewline
  Stop-InstalledProcesses $installRoot

  Invoke-SilentInstall $currentInstaller $installRoot 'Current upgrade'
  Assert-Condition (Test-Path -LiteralPath $dataSentinel -PathType Leaf) 'Upgrade removed the user-data sentinel'
  Assert-Condition ($null -ne (Find-InstalledBinary $installRoot)) 'Current installer did not leave the native companion installed'
  Stop-InstalledProcesses $installRoot

  Invoke-SilentInstall $previousInstaller $installRoot 'Previous downgrade'
  Assert-Condition (Test-Path -LiteralPath $dataSentinel -PathType Leaf) 'Downgrade removed the user-data sentinel'
  Write-Host (ConvertTo-Json @{
    upgradedAndDowngraded = $true
    userDataPreserved = $true
    previousInstaller = $previousInstaller
    currentInstaller = $currentInstaller
  } -Compress)
}
finally {
  Stop-InstalledProcesses $installRoot
  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter 'uninstall.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $uninstaller) {
    $result = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
    if ($result.ExitCode -ne 0) { Write-Warning "Uninstaller returned exit code $($result.ExitCode)" }
  }
  if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $dataSentinel) { Remove-Item -LiteralPath $dataSentinel -Force -ErrorAction SilentlyContinue }
}
