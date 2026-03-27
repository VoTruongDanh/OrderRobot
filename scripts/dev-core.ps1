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
$fallbackCorePort = '18011'

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

function Get-CoreHealth {
  param(
    [string]$BaseUrl
  )

  try {
    return Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-CoreMenuEndpoint {
  param(
    [string]$BaseUrl
  )

  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/menu" -Method Get -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      return $false
    }
    $contentType = [string]$response.Headers['Content-Type']
    return $contentType -like 'application/json*'
  } catch {
    return $false
  }
}

function Test-CoreRuntimeCompatible {
  param(
    [object]$Health,
    [bool]$HasMenuEndpoint
  )

  if ($null -eq $Health) {
    return $false
  }

  return ($Health.status -eq 'ok' -and $HasMenuEndpoint)
}

$candidatePorts = @([string]$corePort)
if ($corePort -ne $fallbackCorePort) {
  $candidatePorts += $fallbackCorePort
}

$resolvedCorePort = $null
foreach ($candidatePort in $candidatePorts) {
  $candidateUrl = "http://127.0.0.1:$candidatePort"
  $listener = Get-ListenerProcessInfo -Port ([int]$candidatePort)

  if ($null -eq $listener) {
    $resolvedCorePort = $candidatePort
    break
  }

  Write-Host "[core] detected existing listener on $candidateUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"
  $health = Get-CoreHealth -BaseUrl $candidateUrl
  $hasMenuEndpoint = Test-CoreMenuEndpoint -BaseUrl $candidateUrl
  $compatibleCore = Test-CoreRuntimeCompatible -Health $health -HasMenuEndpoint $hasMenuEndpoint
  if ($compatibleCore) {
    Write-Host "[core] existing core-backend is compatible. Reusing current instance."
    exit 0
  }

  Write-Host "[core] listener on $candidateUrl is not compatible with current core stack. Trying next candidate port..."
}

if ($null -eq $resolvedCorePort) {
  throw "Unable to find a free Core backend port. Tried: $($candidatePorts -join ', ')."
}

$corePort = $resolvedCorePort
$baseUrl = "http://127.0.0.1:$corePort"
if ($corePort -ne [string]$Port -and $Port) {
  Write-Host "[core] requested port $Port was not available; switched to $corePort"
}

Write-Host "[core] starting core-backend on $baseUrl"

python -m uvicorn app.main:app `
  --reload `
  --reload-dir $coreBackendDir `
  --reload-dir $dataDir `
  --port $corePort `
  --app-dir $coreBackendDir
