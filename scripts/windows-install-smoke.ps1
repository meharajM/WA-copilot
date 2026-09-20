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
  Start-Sleep -Milliseconds 500
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

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter 'uninstall.exe' -File -Recurse | Select-Object -First 1
  Assert-Condition ($null -ne $uninstaller) "NSIS uninstaller was not found under $installRoot"
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  Assert-Condition ($uninstall.ExitCode -eq 0) "NSIS uninstaller failed with exit code $($uninstall.ExitCode)"
  Assert-Condition (-not (Test-Path -LiteralPath $installRoot)) 'NSIS install directory still exists after uninstall'

  Write-Host (ConvertTo-Json @{
    installer = $installer
    health = $healthBody
    installedAndUninstalled = $true
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
  if ($null -ne $companion -and -not $companion.HasExited) { Stop-Process -Id $companion.Id -Force -ErrorAction SilentlyContinue }
  foreach ($agentdPid in $agentdPids) { Stop-Process -Id $agentdPid -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $startupLog) { Remove-Item -LiteralPath $startupLog -Force -ErrorAction SilentlyContinue }
}
