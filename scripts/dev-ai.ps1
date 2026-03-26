param(
  [string]$Port,
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$aiBackendDir = Join-Path $repoRoot 'services\ai-backend'
$dataDir = Join-Path $repoRoot 'data'

if (-not (Test-Path $aiBackendDir)) {
  throw "AI backend source not found at: $aiBackendDir"
}

$aiPort = if ($Port) {
  $Port
} elseif ($env:AI_BACKEND_PORT) {
  $env:AI_BACKEND_PORT
} else {
  '8012'
}

# Force bridge-only defaults for local dev unless user explicitly overrides.
if (-not $env:LLM_MODE) {
  $env:LLM_MODE = 'bridge_only'
}
if (-not $env:BRIDGE_BASE_URL) {
  $env:BRIDGE_BASE_URL = 'http://127.0.0.1:1122'
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

$baseUrl = "http://127.0.0.1:$aiPort"
$listener = Get-ListenerProcessInfo -Port ([int]$aiPort)
if ($null -ne $listener) {
  Write-Host "[ai] detected existing listener on $baseUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"

  if ($ForceRestart.IsPresent) {
    Write-Host "[ai] force restart enabled. stopping existing ai listener..."
    try {
      Stop-Process -Id $listener.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Host "[ai] warning: could not stop pid=$($listener.ProcessId): $($_.Exception.Message). re-checking port..."
    }
    Start-Sleep -Milliseconds 600
    $stillUsed = Get-ListenerProcessInfo -Port ([int]$aiPort)
    if ($null -ne $stillUsed) {
      $healthyBridgeMode = $false
      try {
        $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 2
        $healthyBridgeMode = ($null -ne $health -and $health.status -eq 'ok' -and $health.llm_mode -eq 'bridge_only')
      } catch {
        $healthyBridgeMode = $false
      }

      if ($healthyBridgeMode) {
        Write-Host "[ai] existing ai-backend is already healthy in bridge_only mode. Reusing current instance."
        exit 0
      }

      throw "Failed to free ai port $aiPort. still occupied by pid=$($stillUsed.ProcessId), process=$($stillUsed.ProcessName)."
    }
  } else {

    $isHealthyAi = $false
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 2
      $isHealthyAi = ($null -ne $health -and $health.status -eq 'ok')
    } catch {
      $isHealthyAi = $false
    }

    if ($isHealthyAi) {
      Write-Host "[ai] existing ai-backend is healthy. Reusing current instance."
      exit 0
    }

    Write-Host "[ai] port in use by a non-ai service or unhealthy process."
    if ($listener.Path) {
      Write-Host "[ai] process path: $($listener.Path)"
    }
    if ($listener.CommandLine) {
      Write-Host "[ai] command line: $($listener.CommandLine)"
    }
    throw "Port $aiPort is already in use and did not pass health check at $baseUrl/health. Stop that process or set AI_BACKEND_PORT to a free port."
  }
}

Write-Host "[ai] starting ai-backend on http://127.0.0.1:$aiPort"
Write-Host "[ai] LLM_MODE=$env:LLM_MODE"
Write-Host "[ai] BRIDGE_BASE_URL=$env:BRIDGE_BASE_URL"

python -m uvicorn app.main:app `
  --reload `
  --reload-dir $aiBackendDir `
  --reload-dir $dataDir `
  --port $aiPort `
  --app-dir $aiBackendDir
