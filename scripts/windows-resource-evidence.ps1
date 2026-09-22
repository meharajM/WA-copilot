[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,
  [Parameter(Mandatory = $true)]
  [ValidateSet('open', 'closed')]
  [string]$UiState,
  [Parameter(Mandatory = $true)]
  [ValidateSet('loaded', 'unloaded')]
  [string]$ModelState,
  [ValidateRange(2, 300)]
  [int]$SampleSeconds = 30,
  [ValidateRange(2, 600)]
  [int]$SampleIntervalSeconds = 1,
  [int[]]$AdditionalProcessId = @(),
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Get-ProcessTree([int[]]$Roots, [object[]]$Snapshot) {
  $children = @{}
  foreach ($entry in $Snapshot) {
    $parent = [int]$entry.ParentProcessId
    if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }
    $children[$parent] += [int]$entry.ProcessId
  }

  $seen = @{}
  $queue = [System.Collections.Generic.Queue[int]]::new()
  foreach ($root in $Roots) {
    if ($root -gt 0 -and -not $seen.ContainsKey($root)) {
      $seen[$root] = $true
      $queue.Enqueue($root)
    }
  }
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    foreach ($child in @($children[$parent])) {
      if (-not $seen.ContainsKey($child)) {
        $seen[$child] = $true
        $queue.Enqueue($child)
      }
    }
    Assert-Condition ($seen.Count -le 128) 'Resource evidence process tree exceeded the 128-process bound'
  }
  return @($seen.Keys | ForEach-Object { [int]$_ } | Sort-Object)
}

function Get-ProcessMetadata([int[]]$ProcessIds, [object[]]$Snapshot) {
  $metadata = @()
  foreach ($processId in $ProcessIds) {
    $entry = @($Snapshot | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1)
    $name = if ($entry.Count -gt 0) { [string]$entry[0].Name } else { 'unknown' }
    $metadata += [pscustomobject]@{ pid = $processId; name = $name }
  }
  return @($metadata)
}

Assert-Condition ($RootProcessId -gt 0) 'RootProcessId must be a positive process id'
$allRoots = @($RootProcessId) + @($AdditionalProcessId | Where-Object { $_ -gt 0 })
$initialSnapshot = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$initialIds = Get-ProcessTree -Roots $allRoots -Snapshot $initialSnapshot
Assert-Condition ($initialIds -contains $RootProcessId) "Root process $RootProcessId was not found"

# The process list is captured once and then held fixed. This prevents a
# short-lived child from silently changing the denominator between samples and
# keeps the output bounded. Operators should rerun the evidence command when a
# model or UI process is intentionally started/stopped.
$processMetadata = Get-ProcessMetadata -ProcessIds $initialIds -Snapshot $initialSnapshot
$sampleCount = [Math]::Max(2, [Math]::Ceiling($SampleSeconds / $SampleIntervalSeconds) + 1)
$samples = @()
$startedAt = Get-Date

for ($sampleIndex = 0; $sampleIndex -lt $sampleCount; $sampleIndex++) {
  $rssBytes = [int64]0
  $cpuSeconds = [double]0
  foreach ($processId in $initialIds) {
    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      $rssBytes += [int64]$process.WorkingSet64
      $cpuSeconds += [double]$process.TotalProcessorTime.TotalSeconds
    } catch {
      throw "Tracked process $processId exited during resource sampling"
    }
  }
  $samples += [pscustomobject]@{
    atUtc = (Get-Date).ToUniversalTime().ToString('o')
    rssBytes = $rssBytes
    cpuSeconds = [Math]::Round($cpuSeconds, 6)
    processCount = $initialIds.Count
  }
  if ($sampleIndex -lt ($sampleCount - 1)) {
    Start-Sleep -Seconds $SampleIntervalSeconds
  }
}

$elapsedSeconds = [Math]::Max(1, ((Get-Date) - $startedAt).TotalSeconds)
$peakRssBytes = [int64](($samples | Measure-Object -Property rssBytes -Maximum).Maximum)
$cpuDeltaSeconds = [Math]::Max(0, [double]$samples[-1].cpuSeconds - [double]$samples[0].cpuSeconds)
$averageCpuPercent = [Math]::Round(($cpuDeltaSeconds / ([Environment]::ProcessorCount * $elapsedSeconds)) * 100, 2)
$evidence = [ordered]@{
  schemaVersion = 'windows-resource-evidence.v1'
  capturedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  host = [ordered]@{
    os = 'Windows'
    processorCount = [Environment]::ProcessorCount
    osVersion = [Environment]::OSVersion.Version.ToString()
  }
  state = [ordered]@{
    ui = $UiState
    model = $ModelState
  }
  sampling = [ordered]@{
    requestedSeconds = $SampleSeconds
    intervalSeconds = $SampleIntervalSeconds
    sampleCount = $samples.Count
    elapsedSeconds = [Math]::Round($elapsedSeconds, 3)
  }
  processes = $processMetadata
  samples = $samples
  summary = [ordered]@{
    peakResidentSetMb = [Math]::Round($peakRssBytes / 1MB, 2)
    averageCpuPercent = $averageCpuPercent
    processCount = $initialIds.Count
  }
}

$json = $evidence | ConvertTo-Json -Depth 8
if ($OutputPath) {
  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
  $parent = Split-Path -Parent $resolvedOutput
  if ($parent) { $null = New-Item -ItemType Directory -Force -Path $parent }
  Set-Content -LiteralPath $resolvedOutput -Value $json -Encoding utf8
}
Write-Output $json
