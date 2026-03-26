param(
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$gatewayRoot = Join-Path $repoRoot 'mau\Ay-bi-ai'

if (-not (Test-Path $gatewayRoot)) {
  throw "Bridge gateway source not found at: $gatewayRoot"
}

$bridgePort = if ($env:BRIDGE_GATEWAY_PORT) { $env:BRIDGE_GATEWAY_PORT } else { '1122' }

$env:PORT = $bridgePort
$env:HOST = '127.0.0.1'
$env:PUBLIC_API_HOST = '127.0.0.1'
$env:NODE_ENV = 'development'

# Keep hidden bridge runtime on demand.
# Keep minimized by default to avoid visible browser window on kiosk screens.
$env:BRIDGE_AUTOSTART_ON_DEMAND = 'true'
$env:BRIDGE_LAUNCH_MINIMIZED = if ($env:BRIDGE_LAUNCH_MINIMIZED) { $env:BRIDGE_LAUNCH_MINIMIZED } else { 'true' }
$env:BRIDGE_LAUNCH_OFFSCREEN = if ($env:BRIDGE_LAUNCH_OFFSCREEN) { $env:BRIDGE_LAUNCH_OFFSCREEN } else { 'true' }
$env:BRIDGE_HIDE_WINDOW = if ($env:BRIDGE_HIDE_WINDOW) { $env:BRIDGE_HIDE_WINDOW } else { 'true' }
$env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW = if ($env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW) { $env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW } else { 'true' }
$env:BRIDGE_AUTOSTART = 'true'
$env:BRIDGE_PREFERRED_BROWSER = if ($env:BRIDGE_PREFERRED_BROWSER) { $env:BRIDGE_PREFERRED_BROWSER } else { 'edge' }
$env:BRIDGE_CDP_EXECUTION_ENABLED = if ($env:BRIDGE_CDP_EXECUTION_ENABLED) { $env:BRIDGE_CDP_EXECUTION_ENABLED } else { 'false' }
$env:BRIDGE_CDP_PRIMARY_ENABLED = if ($env:BRIDGE_CDP_PRIMARY_ENABLED) { $env:BRIDGE_CDP_PRIMARY_ENABLED } else { 'false' }

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

function Stop-BridgeRuntimeBrowserProcesses {
  $profileMarker = 'bridge-browser-profile'
  $processes = @()

  try {
    $processes = Get-WmiObject Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='brave.exe' OR Name='firefox.exe'" |
      Where-Object { $_.CommandLine -like "*$profileMarker*" }
  } catch {
    return 0
  }

  if (-not $processes -or $processes.Count -eq 0) {
    return 0
  }

  $stopped = 0
  foreach ($proc in $processes) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      $stopped += 1
    } catch {
      # ignore stop failures and continue with best-effort cleanup
    }
  }

  return $stopped
}

function Start-BridgeWindowHider {
  param(
    [string]$RepoRoot
  )

  $isEnabled = Test-TruthyEnv -Value $env:BRIDGE_HIDE_WINDOW
  if (-not $isEnabled) {
    Write-Host "[bridge] BRIDGE_HIDE_WINDOW=false (skip taskbar window hider)"
    return
  }

  $hiderScript = Join-Path $RepoRoot 'scripts\bridge-hide-window.ps1'
  if (-not (Test-Path $hiderScript)) {
    Write-Host "[bridge] window hider script not found: $hiderScript"
    return
  }

  $profileMarker = 'bridge-browser-profile'
  $existing = @()
  try {
    $existing = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
      Where-Object { $_.CommandLine -like "*bridge-hide-window.ps1*" -and $_.CommandLine -like "*$profileMarker*" }
  } catch {
    $existing = @()
  }

  if ($existing.Count -gt 0) {
    foreach ($proc in $existing) {
      try {
        Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop
      } catch {
        # ignore stop failures
      }
    }
    Start-Sleep -Milliseconds 250
    Write-Host "[bridge] restarted window hider (replaced $($existing.Count) old process(es))"
  }

  try {
    $hideByTitleFlag = if (Test-TruthyEnv -Value $env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW) { '$true' } else { '$false' }
    Start-Process -FilePath "powershell" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $hiderScript,
      '-ProfileMarker', $profileMarker,
      '-IntervalMs', '900',
      '-HideChatGptTitleWindows', $hideByTitleFlag
    ) | Out-Null
    Write-Host "[bridge] window hider started (taskbar suppression enabled)"
  } catch {
    Write-Host "[bridge] failed to start window hider: $($_.Exception.Message)"
  }
}

function Get-ListenerProcessInfo {
  param(
    [int]$Port
  )

  $connection = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $connection) {
    return $null
  }

  $ownerPid = [int]$connection.OwningProcess
  $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  $commandLine = $null

  try {
    $commandLine = (Get-WmiObject Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop).CommandLine
  } catch {
    $commandLine = $null
  }

  return [PSCustomObject]@{
    ProcessId = $ownerPid
    ProcessName = if ($null -ne $process) { $process.ProcessName } else { 'unknown' }
    Path = if ($null -ne $process) { $process.Path } else { $null }
    CommandLine = $commandLine
  }
}

$shouldForceRestart = $ForceRestart.IsPresent -or (Test-TruthyEnv -Value $env:BRIDGE_FORCE_RESTART)
$bridgeUrl = "http://127.0.0.1:$bridgePort"
$listener = Get-ListenerProcessInfo -Port ([int]$bridgePort)
if ($null -ne $listener) {
  Write-Host "[bridge] detected existing listener on $bridgeUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"

  if ($shouldForceRestart) {
    Write-Host "[bridge] force restart enabled. stopping existing bridge listener..."
    try {
      Stop-Process -Id $listener.ProcessId -Force -ErrorAction Stop
    } catch {
      throw "Failed to stop existing bridge process pid=$($listener.ProcessId): $($_.Exception.Message)"
    }

    Start-Sleep -Milliseconds 700
    $portCheck = Get-ListenerProcessInfo -Port ([int]$bridgePort)
    if ($null -ne $portCheck) {
      throw "Port $bridgePort is still occupied after force restart attempt (pid=$($portCheck.ProcessId), process=$($portCheck.ProcessName))."
    }

    $stoppedWorkers = Stop-BridgeRuntimeBrowserProcesses
    if ($stoppedWorkers -gt 0) {
      Write-Host "[bridge] stopped $stoppedWorkers runtime browser process(es) using bridge profile."
    }
  } else {
    $isHealthyBridge = $false
    try {
      $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -Method Get -TimeoutSec 2
      $isHealthyBridge = ($null -ne $health -and $health.status -eq 'ok')
    } catch {
      $isHealthyBridge = $false
    }

    if ($isHealthyBridge) {
      Write-Host "[bridge] existing gateway is healthy. Reusing current bridge instance."
      exit 0
    }

    Write-Host "[bridge] port in use by a non-bridge process or unhealthy service."
    if ($listener.Path) {
      Write-Host "[bridge] process path: $($listener.Path)"
    }
    if ($listener.CommandLine) {
      Write-Host "[bridge] command line: $($listener.CommandLine)"
    }
    throw "Port $bridgePort is already in use and did not pass bridge health check at $bridgeUrl/health. Stop that process or set BRIDGE_GATEWAY_PORT to a free port."
  }
} elseif ($shouldForceRestart) {
  $stoppedWorkers = Stop-BridgeRuntimeBrowserProcesses
  if ($stoppedWorkers -gt 0) {
    Write-Host "[bridge] stopped $stoppedWorkers stale runtime browser process(es) before startup."
  }
}

Write-Host "[bridge] starting DPG gateway from $gatewayRoot on $bridgeUrl"
Write-Host "[bridge] BRIDGE_LAUNCH_MINIMIZED=$env:BRIDGE_LAUNCH_MINIMIZED"
Write-Host "[bridge] BRIDGE_LAUNCH_OFFSCREEN=$env:BRIDGE_LAUNCH_OFFSCREEN"
Write-Host "[bridge] BRIDGE_HIDE_WINDOW=$env:BRIDGE_HIDE_WINDOW"
Write-Host "[bridge] BRIDGE_HIDE_CHATGPT_TITLE_WINDOW=$env:BRIDGE_HIDE_CHATGPT_TITLE_WINDOW"
Write-Host "[bridge] BRIDGE_PREFERRED_BROWSER=$env:BRIDGE_PREFERRED_BROWSER"
Write-Host "[bridge] BRIDGE_CDP_EXECUTION_ENABLED=$env:BRIDGE_CDP_EXECUTION_ENABLED"
Write-Host "[bridge] BRIDGE_CDP_PRIMARY_ENABLED=$env:BRIDGE_CDP_PRIMARY_ENABLED"
Write-Host "[bridge] BRIDGE_FORCE_RESTART=$shouldForceRestart"
Write-Host "[bridge] if first run: npm run install:bridge"
Start-BridgeWindowHider -RepoRoot $repoRoot

npm --prefix $gatewayRoot run dev
