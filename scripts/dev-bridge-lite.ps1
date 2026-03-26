param(
  [string]$Port
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$bridgeLiteScript = Join-Path $repoRoot 'scripts\bridge-lite-server.mjs'

if (-not (Test-Path $bridgeLiteScript)) {
  throw "Bridge-lite server script not found at: $bridgeLiteScript"
}

$bridgePort = if ($Port) {
  $Port
} elseif ($env:BRIDGE_GATEWAY_PORT) {
  $env:BRIDGE_GATEWAY_PORT
} else {
  '1122'
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
  return [PSCustomObject]@{
    ProcessId = $ownerPid
    ProcessName = if ($null -ne $process) { $process.ProcessName } else { 'unknown' }
  }
}

$listener = Get-ListenerProcessInfo -Port ([int]$bridgePort)
if ($null -ne $listener) {
  Write-Host "[bridge-lite] detected existing listener on http://127.0.0.1:$bridgePort (pid=$($listener.ProcessId), process=$($listener.ProcessName))"
  Write-Host "[bridge-lite] stopping existing listener to run lite mode..."
  try {
    Stop-Process -Id $listener.ProcessId -Force -ErrorAction Stop
  } catch {
    Write-Host "[bridge-lite] warning: could not stop pid=$($listener.ProcessId): $($_.Exception.Message)"
  }
  Start-Sleep -Milliseconds 700
  $stillUsed = Get-ListenerProcessInfo -Port ([int]$bridgePort)
  if ($null -ne $stillUsed) {
    throw "Bridge port $bridgePort is still occupied by pid=$($stillUsed.ProcessId), process=$($stillUsed.ProcessName)."
  }
}

$env:PORT = $bridgePort
$env:HOST = '127.0.0.1'
Write-Host "[bridge-lite] starting bridge-lite on http://127.0.0.1:$bridgePort"

node --watch $bridgeLiteScript

