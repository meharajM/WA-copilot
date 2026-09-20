[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

$installer = [System.IO.Path]::GetFullPath($InstallerPath)
Assert-Condition (Test-Path -LiteralPath $installer -PathType Leaf) "NSIS installer not found: $installer"

$smokeId = [Guid]::NewGuid().ToString('N')
$installRoot = Join-Path $env:RUNNER_TEMP "aica-install-smoke-$smokeId"
$startupLog = Join-Path $installRoot 'agentd-startup.log'
$dataRoots = @(
  (Join-Path $env:APPDATA 'com.aica.tauri-pilot'),
  (Join-Path $env:LOCALAPPDATA 'com.aica.tauri-pilot')
)
$null = New-Item -ItemType Directory -Force -Path $installRoot

$companion = $null
$agentdPids = @()

try {
  # NSIS accepts /D= only as the final argument. The generated installer is
  # unsigned in CI, so this gate verifies runtime/package behavior separately
  # from release certificate validation.
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
  Assert-Condition ($install.ExitCode -eq 0) "NSIS installer failed with exit code $($install.ExitCode)"

  $binary = Get-ChildItem -LiteralPath $installRoot -Filter 'aica-tauri-pilot.exe' -File -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $binary) "Installed native companion executable was not found under $installRoot"

  $env:AICA_AGENTD_STARTUP_LOG = $startupLog
  $companion = Start-Process -FilePath $binary.FullName -ArgumentList '--background' -PassThru
  $deadline = (Get-Date).AddSeconds(20)
  $descriptor = $null
  while ((Get-Date) -lt $deadline) {
    foreach ($dataRoot in $dataRoots) {
      $descriptorPath = Join-Path $dataRoot 'agentd.runtime.json'
      if (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { continue }
      try { $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json } catch { $descriptor = $null }
      if ($null -ne $descriptor -and $descriptor.origin -match '^http://127\.0\.0\.1:\d+$' -and [int]$descriptor.pid -gt 0) { break }
    }
    if ($null -ne $descriptor) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($null -eq $descriptor) {
    $processState = if ($null -eq $companion) {
      'not-started'
    } elseif ($companion.HasExited) {
      "exited($($companion.ExitCode))"
    } else {
      'still-running'
    }
    $descriptorCandidates = @()
    foreach ($root in $dataRoots) {
      if (Test-Path -LiteralPath $root -PathType Container) {
        $descriptorCandidates += @(Get-ChildItem -LiteralPath $root -Filter 'agentd.runtime.json' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName)
      }
    }
    $candidateText = if ($descriptorCandidates.Count) { $descriptorCandidates -join ', ' } else { 'none' }
    $startupText = if (Test-Path -LiteralPath $startupLog -PathType Leaf) {
      (Get-Content -LiteralPath $startupLog -Raw -ErrorAction SilentlyContinue).Trim()
    } else {
      'none'
    }
    if ($startupText.Length -gt 4096) { $startupText = $startupText.Substring($startupText.Length - 4096) }
    throw "Native companion did not publish a valid private agentd descriptor (process=$processState; candidates=$candidateText; startup=$startupText)"
  }

  $health = Invoke-WebRequest -Uri "$($descriptor.origin)/healthz" -UseBasicParsing -TimeoutSec 5
  Assert-Condition ($health.StatusCode -eq 200) "agentd health check returned HTTP $($health.StatusCode)"
  $healthBody = $health.Content | ConvertFrom-Json
  Assert-Condition ($healthBody.ok -eq $true) 'agentd health response was not ok=true'

  # The host deliberately leaves agentd alive when the companion exits. Stop
  # both processes explicitly so the CI runner cannot retain a user service.
  if ($null -ne $companion -and -not $companion.HasExited) {
    Stop-Process -Id $companion.Id -Force -ErrorAction SilentlyContinue
  }
  $agentdPids = @(Get-CimInstance Win32_Process -Filter "Name = 'agentd-runtime.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('agentd-http') } |
    Select-Object -ExpandProperty ProcessId)
  foreach ($agentdPid in $agentdPids) { Stop-Process -Id $agentdPid -Force -ErrorAction SilentlyContinue }

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter 'uninstall.exe' -File -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $uninstaller) "NSIS uninstaller was not found under $installRoot"
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  Assert-Condition ($uninstall.ExitCode -eq 0) "NSIS uninstaller failed with exit code $($uninstall.ExitCode)"
  Assert-Condition (-not (Test-Path -LiteralPath $installRoot)) 'NSIS install directory still exists after uninstall'

  Write-Host (ConvertTo-Json @{ installer = $installer; health = $healthBody; installedAndUninstalled = $true } -Compress)
}
finally {
  Remove-Item Env:AICA_AGENTD_STARTUP_LOG -ErrorAction SilentlyContinue
  if ($null -ne $companion -and -not $companion.HasExited) { Stop-Process -Id $companion.Id -Force -ErrorAction SilentlyContinue }
  foreach ($agentdPid in $agentdPids) { Stop-Process -Id $agentdPid -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
