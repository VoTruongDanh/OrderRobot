param(
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

Write-Host "Starting Standalone Bridge Server (No Docker)"
Write-Host "Node version: $(node -v)"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$profileMarker = 'bridge-chrome-profile'

$env:PORT = if ($env:BRIDGE_GATEWAY_PORT) { $env:BRIDGE_GATEWAY_PORT } else { '1122' }
$env:HOST = '127.0.0.1'
$env:BRIDGE_LAUNCH_MINIMIZED = if ($env:BRIDGE_LAUNCH_MINIMIZED) { $env:BRIDGE_LAUNCH_MINIMIZED } else { 'true' }
$env:BRIDGE_LAUNCH_OFFSCREEN = if ($env:BRIDGE_LAUNCH_OFFSCREEN) { $env:BRIDGE_LAUNCH_OFFSCREEN } else { 'true' }
$env:BRIDGE_HIDE_WINDOW = if ($env:BRIDGE_HIDE_WINDOW) { $env:BRIDGE_HIDE_WINDOW } else { 'true' }
$env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW = if ($env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW) { $env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW } else { 'true' }

function Get-ListenerProcessInfo {
  param(
    [int]$Port
  )

  $portPattern = "^\s*TCP\s+127\.0\.0\.1:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
  $matched = $null
  try {
    $matched = netstat -ano -p tcp | Select-String -Pattern $portPattern | Select-Object -First 1
  } catch {
    $matched = $null
  }

  if ($null -eq $matched) {
    return $null
  }

  $ownerPid = 0
  if (-not [int]::TryParse($matched.Matches[0].Groups[1].Value, [ref]$ownerPid)) {
    return $null
  }
  $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue

  return [PSCustomObject]@{
    ProcessId = $ownerPid
    ProcessName = if ($null -ne $process) { $process.ProcessName } else { 'unknown' }
    Path = if ($null -ne $process) { $process.Path } else { $null }
    CommandLine = $null
  }
}

function Get-BridgeHealth {
  param(
    [string]$BaseUrl
  )

  try {
    return Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-TruthyEnv {
  param(
    [string]$Value
  )

  if (-not $Value) {
    return $false
  }

  $normalized = $Value.Trim().ToLowerInvariant()
  return @('1', 'true', 'yes', 'y', 'on') -contains $normalized
}

function Start-BridgeWindowHider {
  param(
    [string]$RepoRoot,
    [string]$ProfileMarker,
    [switch]$Restart
  )

  $isEnabled = Test-TruthyEnv -Value $env:BRIDGE_HIDE_WINDOW
  if (-not $isEnabled) {
    Write-Host "[bridge] BRIDGE_HIDE_WINDOW=false (skip window hider)"
    return
  }

  $hiderScript = Join-Path $RepoRoot 'scripts\bridge-hide-window.ps1'
  if (-not (Test-Path $hiderScript)) {
    Write-Host "[bridge] window hider script not found: $hiderScript"
    return
  }

  $existing = @()
  try {
    $existing = Get-WmiObject Win32_Process |
      Where-Object {
        ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe') -and
        $_.CommandLine -like '*bridge-hide-window.ps1*' -and
        $_.CommandLine -like "*$ProfileMarker*"
      }
  } catch {
    $existing = @()
  }

  if ($existing.Count -gt 0 -and $Restart.IsPresent) {
    foreach ($proc in $existing) {
      try {
        Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop
      } catch {
        # ignore stop failures
      }
    }
    Start-Sleep -Milliseconds 250
    Write-Host "[bridge] restarted window hider (replaced $($existing.Count) old process(es))"
    $existing = @()
  }

  if ($existing.Count -gt 0) {
    Write-Host "[bridge] window hider already running"
    return
  }

  try {
    $hideByTitleFlag = if (Test-TruthyEnv -Value $env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW) { '$true' } else { '$false' }
    Start-Process -FilePath "powershell" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $hiderScript,
      '-ProfileMarker', $ProfileMarker,
      '-IntervalMs', '900',
      '-HideChatGptTitleWindows', $hideByTitleFlag
    ) | Out-Null
    Write-Host "[bridge] window hider started"
  } catch {
    Write-Host "[bridge] failed to start window hider: $($_.Exception.Message)"
  }
}

$bridgePort = [int]$env:PORT
$bridgeUrl = "http://127.0.0.1:$bridgePort"
$listener = Get-ListenerProcessInfo -Port $bridgePort

if ($null -ne $listener) {
  Write-Host "[bridge] detected existing listener on $bridgeUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"

  if ($ForceRestart.IsPresent) {
    Write-Host "[bridge] force restart enabled. stopping existing bridge listener..."
    try {
      Stop-Process -Id $listener.ProcessId -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 700
    } catch {
      throw "Failed to stop existing bridge listener pid=$($listener.ProcessId): $($_.Exception.Message)"
    }

    $stillUsed = Get-ListenerProcessInfo -Port $bridgePort
    if ($null -ne $stillUsed) {
      throw "Port $bridgePort is still occupied after force restart (pid=$($stillUsed.ProcessId), process=$($stillUsed.ProcessName))."
    }
  } else {
    $health = Get-BridgeHealth -BaseUrl $bridgeUrl
    if ($null -ne $health -and $health.status -eq 'ok') {
      Start-BridgeWindowHider -RepoRoot $repoRoot -ProfileMarker $profileMarker -Restart:$ForceRestart
      Write-Host "[bridge] existing gateway is healthy. Reusing current bridge instance."
      exit 0
    }

    if ($listener.Path) {
      Write-Host "[bridge] process path: $($listener.Path)"
    }
    if ($listener.CommandLine) {
      Write-Host "[bridge] command line: $($listener.CommandLine)"
    }
    throw "Port $bridgePort is already in use and bridge health check failed at $bridgeUrl/health."
  }
}

Start-BridgeWindowHider -RepoRoot $repoRoot -ProfileMarker $profileMarker -Restart:$ForceRestart

# Start the Node script directly
node scripts/bridge-server.mjs
