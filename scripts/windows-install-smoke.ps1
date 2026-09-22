[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [int]$MaxResidentSetMb = 512,
  [double]$MaxAverageCpuPercent = 50,
  [int]$ResourceSampleSeconds = 5
)

$ErrorActionPreference = 'Stop'

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-TaskQuery([string]$TaskName) {
  $schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'
  Assert-Condition (Test-Path -LiteralPath $schtasks -PathType Leaf) 'Windows Task Scheduler CLI was not found'
  $output = @(& $schtasks /Query /TN $TaskName /FO LIST /NH 2>$null)
  return [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output = $output -join "`n"
  }
}

$installer = [System.IO.Path]::GetFullPath($InstallerPath)
Assert-Condition (Test-Path -LiteralPath $installer -PathType Leaf) "NSIS installer not found: $installer"

$smokeId = [Guid]::NewGuid().ToString('N')
$installRoot = Join-Path $env:RUNNER_TEMP "aica-install-smoke-$smokeId"
$startupLog = Join-Path $env:RUNNER_TEMP "aica-agentd-startup-$smokeId.log"
$dataRoots = @(
  (Join-Path $env:APPDATA 'com.aica.tauri-pilot'),
  (Join-Path $env:LOCALAPPDATA 'com.aica.tauri-pilot')
)
$null = New-Item -ItemType Directory -Force -Path $installRoot

$companion = $null
$agentdPids = @()
$binary = $null
$serviceRegistered = $false
$dataSentinel = Join-Path (Join-Path $env:LOCALAPPDATA 'com.aica.tauri-pilot') "install-smoke-$smokeId.txt"
$reinstallDataPreserved = $false

try {
  # NSIS accepts /D= only as the final argument. The generated installer is
  # unsigned in CI, so this gate verifies runtime/package behavior separately
  # from release certificate validation.
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
  Assert-Condition ($install.ExitCode -eq 0) "NSIS installer failed with exit code $($install.ExitCode)"

  $binary = Get-ChildItem -LiteralPath $installRoot -Filter 'aica-tauri-pilot.exe' -File -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $binary) "Installed native companion executable was not found under $installRoot"

  # Exercise explicit service enrollment through the packaged companion. The
  # task name is fixed by the product contract, so refuse to overwrite an
  # existing user task in a shared runner. Cleanup runs in finally below.
  $taskName = 'AICA Native Companion'
  $initialTask = Invoke-TaskQuery $taskName
  Assert-Condition ($initialTask.ExitCode -ne 0) "Refusing to overwrite pre-existing Task Scheduler entry: $taskName"
  $statusAction = Start-Process -FilePath $binary.FullName -ArgumentList '--service-status' -Wait -PassThru
  Assert-Condition ($statusAction.ExitCode -eq 0) "Packaged service-status action failed with exit code $($statusAction.ExitCode)"
  $registerAction = Start-Process -FilePath $binary.FullName -ArgumentList '--register-service' -Wait -PassThru
  Assert-Condition ($registerAction.ExitCode -eq 0) "Packaged service registration failed with exit code $($registerAction.ExitCode)"
  $serviceRegistered = $true
  $registeredTask = Invoke-TaskQuery $taskName
  Assert-Condition ($registeredTask.ExitCode -eq 0) 'Registered native companion task was not queryable'
  Assert-Condition ($registeredTask.Output -match [regex]::Escape($taskName)) 'Task Scheduler query returned an unexpected task'
  $unregisterAction = Start-Process -FilePath $binary.FullName -ArgumentList '--unregister-service' -Wait -PassThru
  Assert-Condition ($unregisterAction.ExitCode -eq 0) "Packaged service removal failed with exit code $($unregisterAction.ExitCode)"
  $serviceRegistered = $false
  $removedTask = Invoke-TaskQuery $taskName
  Assert-Condition ($removedTask.ExitCode -ne 0) 'Native companion task remained after explicit cleanup'

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

  # Measure the complete native companion + agentd footprint while idle. This
  # is intentionally a conservative regression guard, not a claim about a
  # user's local model workload: the browser UI and model process are outside
  # this install smoke. The descriptor PID is the daemon owner; the companion
  # PID is the native host launched above.
  $resourcePids = @($companion.Id, [int]$descriptor.pid) | Sort-Object -Unique
  $resourceSamples = @()
  $sampleCount = [Math]::Max(2, $ResourceSampleSeconds + 1)
  $sampleStarted = Get-Date
  for ($sampleIndex = 0; $sampleIndex -lt $sampleCount; $sampleIndex++) {
    $rssBytes = [int64]0
    $cpuSeconds = [double]0
    $sampleProcesses = @()
    foreach ($resourcePid in $resourcePids) {
      $process = Get-Process -Id $resourcePid -ErrorAction SilentlyContinue
      if ($null -eq $process) { continue }
      $rssBytes += [int64]$process.WorkingSet64
      $cpuSeconds += [double]$process.TotalProcessorTime.TotalSeconds
      $sampleProcesses += $process.ProcessName
    }
    Assert-Condition ($sampleProcesses.Count -eq $resourcePids.Count) 'Native companion or agentd exited during resource sampling'
    $resourceSamples += [pscustomobject]@{
      at = (Get-Date).ToUniversalTime().ToString('o')
      rssBytes = $rssBytes
      cpuSeconds = $cpuSeconds
      processes = @($sampleProcesses | Sort-Object -Unique)
    }
    if ($sampleIndex -lt ($sampleCount - 1)) { Start-Sleep -Seconds 1 }
  }
  $peakRssMb = [Math]::Ceiling((($resourceSamples | Measure-Object -Property rssBytes -Maximum).Maximum) / 1MB)
  $elapsedSeconds = [Math]::Max(1, ((Get-Date) - $sampleStarted).TotalSeconds)
  $cpuDeltaSeconds = [Math]::Max(0, [double]$resourceSamples[-1].cpuSeconds - [double]$resourceSamples[0].cpuSeconds)
  $averageCpuPercent = [Math]::Round(($cpuDeltaSeconds / ([Environment]::ProcessorCount * $elapsedSeconds)) * 100, 2)
  Assert-Condition ($peakRssMb -le $MaxResidentSetMb) "Native companion + agentd exceeded resident-memory guard: ${peakRssMb} MB > ${MaxResidentSetMb} MB"
  Assert-Condition ($averageCpuPercent -le $MaxAverageCpuPercent) "Native companion + agentd exceeded idle CPU guard: ${averageCpuPercent}% > ${MaxAverageCpuPercent}%"

  # The host deliberately leaves agentd alive when the companion exits. Stop
  # both processes explicitly so the CI runner cannot retain a user service.
  if ($null -ne $companion -and -not $companion.HasExited) {
    Stop-Process -Id $companion.Id -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $companion) { $companion.WaitForExit(5000) | Out-Null }
  Start-Sleep -Milliseconds 500
  # The browser-first contract keeps the independently supervised daemon alive
  # when the native companion window/process exits. Prove that lifecycle
  # boundary before explicitly cleaning up the disposable daemon below.
  $survivingHealth = Invoke-WebRequest -Uri "$($descriptor.origin)/healthz" -UseBasicParsing -TimeoutSec 5
  Assert-Condition ($survivingHealth.StatusCode -eq 200) "agentd stopped when the native companion exited (HTTP $($survivingHealth.StatusCode))"
  $survivingHealthBody = $survivingHealth.Content | ConvertFrom-Json
  Assert-Condition ($survivingHealthBody.ok -eq $true) 'agentd health was not ok=true after native companion exit'
  $runtimeBinary = Get-ChildItem -LiteralPath $installRoot -Filter 'agentd-runtime.exe' -File -Recurse | Select-Object -First 1
  $runtimePath = if ($null -ne $runtimeBinary) { $runtimeBinary.FullName } else { '' }
  $agentdPids = @(Get-CimInstance Win32_Process -Filter "Name = 'agentd-runtime.exe'" |
    Where-Object {
      ($runtimePath -and $_.ExecutablePath -and $_.ExecutablePath -ieq $runtimePath) -or
      ($_.CommandLine -and $_.CommandLine.Contains($installRoot)) -or
      ($null -ne $companion -and $_.ParentProcessId -eq $companion.Id)
    } |
    Select-Object -ExpandProperty ProcessId)
  foreach ($agentdPid in $agentdPids) { Stop-Process -Id $agentdPid -Force -ErrorAction SilentlyContinue }

  # Exercise the repair/reinstall path against the same isolated install root.
  # The sentinel lives under the real per-user data root (not the install
  # directory), so this proves a reinstall does not delete user data while
  # keeping the smoke fully disposable and scoped to its unique run id.
  $dataSentinelRoot = Split-Path -Parent $dataSentinel
  $null = New-Item -ItemType Directory -Force -Path $dataSentinelRoot
  Set-Content -LiteralPath $dataSentinel -Value "reinstall-sentinel-$smokeId" -NoNewline
  $repairInstall = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru
  Assert-Condition ($repairInstall.ExitCode -eq 0) "NSIS reinstall/repair failed with exit code $($repairInstall.ExitCode)"
  Assert-Condition (Test-Path -LiteralPath $dataSentinel -PathType Leaf) 'NSIS reinstall removed the user-data sentinel'
  $reinstallDataPreserved = $true

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter 'uninstall.exe' -File -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $uninstaller) "NSIS uninstaller was not found under $installRoot"
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  Assert-Condition ($uninstall.ExitCode -eq 0) "NSIS uninstaller failed with exit code $($uninstall.ExitCode)"
  Assert-Condition (-not (Test-Path -LiteralPath $installRoot)) 'NSIS install directory still exists after uninstall'

  Write-Host (ConvertTo-Json @{
    installer = $installer
    health = $healthBody
    installedAndUninstalled = $true
    reinstallDataPreserved = $reinstallDataPreserved
    resourceGuard = @{
      sampleSeconds = $ResourceSampleSeconds
      peakResidentSetMb = $peakRssMb
      averageCpuPercent = $averageCpuPercent
      maxResidentSetMb = $MaxResidentSetMb
      maxAverageCpuPercent = $MaxAverageCpuPercent
      processes = @($resourcePids)
    }
  } -Compress)
}
finally {
  Remove-Item Env:AICA_AGENTD_STARTUP_LOG -ErrorAction SilentlyContinue
  if ($serviceRegistered -and $null -ne $binary -and (Test-Path -LiteralPath $binary.FullName -PathType Leaf)) {
    $cleanup = Start-Process -FilePath $binary.FullName -ArgumentList '--unregister-service' -Wait -PassThru
    if ($cleanup.ExitCode -ne 0) {
      $schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'
      & $schtasks /Delete /TN 'AICA Native Companion' /F 2>$null | Out-Null
    }
  }
  if ($null -ne $companion -and -not $companion.HasExited) { Stop-Process -Id $companion.Id -Force -ErrorAction SilentlyContinue }
  foreach ($agentdPid in $agentdPids) { Stop-Process -Id $agentdPid -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $startupLog) { Remove-Item -LiteralPath $startupLog -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $dataSentinel) { Remove-Item -LiteralPath $dataSentinel -Force -ErrorAction SilentlyContinue }
}
