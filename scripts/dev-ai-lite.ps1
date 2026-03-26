param(
  [string]$Port
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

# Lite mode: disable bridge/OpenAI calls and use local fallback replies.
$env:LLM_MODE = 'disabled'
if ($env:BRIDGE_BASE_URL) {
  Remove-Item Env:BRIDGE_BASE_URL -ErrorAction SilentlyContinue
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
  Write-Host "[ai-lite] detected existing listener on $baseUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"

  $isHealthyAi = $false
  try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 2
    $isHealthyAi = ($null -ne $health -and $health.status -eq 'ok')
  } catch {
    $isHealthyAi = $false
  }

  if ($isHealthyAi) {
    Write-Host "[ai-lite] existing ai-backend is healthy. Reusing current instance."
    exit 0
  }

  Write-Host "[ai-lite] port in use by a non-ai service or unhealthy process."
  if ($listener.Path) {
    Write-Host "[ai-lite] process path: $($listener.Path)"
  }
  if ($listener.CommandLine) {
    Write-Host "[ai-lite] command line: $($listener.CommandLine)"
  }
  throw "Port $aiPort is already in use and did not pass health check at $baseUrl/health. Stop that process or set AI_BACKEND_PORT to a free port."
}

Write-Host "[ai-lite] starting ai-backend on http://127.0.0.1:$aiPort"
Write-Host "[ai-lite] LLM_MODE=$env:LLM_MODE (bridge disabled)"

python -m uvicorn app.main:app `
  --reload `
  --reload-dir $aiBackendDir `
  --reload-dir $dataDir `
  --port $aiPort `
  --app-dir $aiBackendDir

