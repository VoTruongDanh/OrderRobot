param(
  [string]$Port
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$coreBackendDir = Join-Path $repoRoot 'services\core-backend'
$dataDir = Join-Path $repoRoot 'data'

if (-not (Test-Path $coreBackendDir)) {
  throw "Core backend source not found at: $coreBackendDir"
}

$corePort = if ($Port) {
  $Port
} elseif ($env:CORE_BACKEND_PORT) {
  $env:CORE_BACKEND_PORT
} else {
  '8011'
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

$baseUrl = "http://127.0.0.1:$corePort"
$listener = Get-ListenerProcessInfo -Port ([int]$corePort)
if ($null -ne $listener) {
  Write-Host "[core] detected existing listener on $baseUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"

  $isHealthyCore = $false
  try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 2
    $isHealthyCore = ($null -ne $health -and $health.status -eq 'ok')
  } catch {
    $isHealthyCore = $false
  }

  if ($isHealthyCore) {
    Write-Host "[core] existing core-backend is healthy. Reusing current instance."
    exit 0
  }

  Write-Host "[core] port in use by a non-core service or unhealthy process."
  if ($listener.Path) {
    Write-Host "[core] process path: $($listener.Path)"
  }
  if ($listener.CommandLine) {
    Write-Host "[core] command line: $($listener.CommandLine)"
  }
  throw "Port $corePort is already in use and did not pass health check at $baseUrl/health. Stop that process or set CORE_BACKEND_PORT to a free port."
}

Write-Host "[core] starting core-backend on $baseUrl"

python -m uvicorn app.main:app `
  --reload `
  --reload-dir $coreBackendDir `
  --reload-dir $dataDir `
  --port $corePort `
  --app-dir $coreBackendDir
