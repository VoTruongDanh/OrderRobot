param(
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'
$hiderProcess = $null

Write-Host "Starting Standalone Bridge Server (No Docker)"
Write-Host "Node version: $(node -v)"

$env:PORT = if ($env:BRIDGE_GATEWAY_PORT) { $env:BRIDGE_GATEWAY_PORT } else { '1122' }
$env:HOST = '127.0.0.1'
$env:BRIDGE_HIDE_CHAT_WINDOW = if ($env:BRIDGE_HIDE_CHAT_WINDOW) { $env:BRIDGE_HIDE_CHAT_WINDOW } else { '1' }
$bridgePort = [int]$env:PORT

function Resolve-BridgePortConflict {
  param(
    [int]$Port,
    [switch]$ForceRestart
  )

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)

  if ($listeners.Count -eq 0) {
    return
  }

  foreach ($listenerPid in $listeners) {
    if ($listenerPid -eq $PID) {
      continue
    }

    $proc = $null
    try {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction Stop
    } catch {
      continue
    }

    $cmd = [string]$proc.CommandLine
    $name = [string]$proc.Name
    $isBridgeProcess = $cmd -match 'bridge-server\.mjs'

    if ($isBridgeProcess -or $ForceRestart) {
      Write-Warning "Port $Port is already in use by PID $listenerPid ($name). Stopping it before restart."
      try { Stop-Process -Id $listenerPid -Force -ErrorAction Stop } catch {}
      continue
    }

    throw "Port $Port is already in use by PID $listenerPid ($name). Stop that process or run dev:bridge:dev to force restart."
  }

  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline) {
    $stillUsed = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $stillUsed) {
      return
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Port $Port is still in use after attempting cleanup."
}

try {
  Resolve-BridgePortConflict -Port $bridgePort -ForceRestart:$ForceRestart

  $hiderScript = Join-Path $PSScriptRoot 'bridge-hide-window.ps1'
  if (Test-Path $hiderScript) {
    $hiderProcess = Start-Process `
      -FilePath 'powershell' `
      -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $hiderScript,
        '-ProfileMarker', 'bridge-chrome-profile',
        '-IntervalMs', '300'
      ) `
      -WindowStyle Hidden `
      -PassThru
    Write-Host "Bridge window hider started (PID: $($hiderProcess.Id))"
  } else {
    Write-Warning "bridge-hide-window.ps1 not found, bridge browser window may appear."
  }

  # Start the Node script directly
  node scripts/bridge-server.mjs
}
finally {
  if ($hiderProcess -and -not $hiderProcess.HasExited) {
    try { Stop-Process -Id $hiderProcess.Id -Force } catch {}
  }
}
