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
$fallbackAiPort = '18012'

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

function Get-AiHealth {
  param(
    [string]$BaseUrl
  )

  try {
    return Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 2
  } catch {
    return $null
  }
}

function Test-AiRuntimeCompatible {
  param(
    [object]$Health
  )

  if ($null -eq $Health) {
    return $false
  }

  if ($Health.status -ne 'ok') {
    return $false
  }

  $hasTtsEngine = $Health.PSObject.Properties.Name -contains 'tts_engine'
  $hasSttModel = $Health.PSObject.Properties.Name -contains 'stt_model'
  return ($hasTtsEngine -and $hasSttModel)
}

$candidatePorts = @([string]$aiPort)
if ($aiPort -ne $fallbackAiPort) {
  $candidatePorts += $fallbackAiPort
}

$resolvedPort = $null
foreach ($candidatePort in $candidatePorts) {
  $candidateUrl = "http://127.0.0.1:$candidatePort"
  $listener = Get-ListenerProcessInfo -Port ([int]$candidatePort)
  if ($null -eq $listener) {
    $resolvedPort = $candidatePort
    break
  }

  Write-Host "[ai] detected existing listener on $candidateUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"
  $health = Get-AiHealth -BaseUrl $candidateUrl
  $compatibleBridge = (Test-AiRuntimeCompatible -Health $health) -and ($health.llm_mode -eq 'bridge_only')
  if ($compatibleBridge) {
    Write-Host "[ai] existing ai-backend is compatible (realtime + bridge_only). Reusing current instance."
    exit 0
  }

  if ($ForceRestart.IsPresent) {
    Write-Host "[ai] force restart enabled. trying to stop listener on $candidateUrl ..."
    try {
      Stop-Process -Id $listener.ProcessId -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 600
    } catch {
      Write-Host "[ai] warning: could not stop pid=$($listener.ProcessId): $($_.Exception.Message)"
    }

    $stillUsed = Get-ListenerProcessInfo -Port ([int]$candidatePort)
    if ($null -eq $stillUsed) {
      $resolvedPort = $candidatePort
      break
    }
  }

  Write-Host "[ai] listener on $candidateUrl is not compatible with current realtime stack. Trying next candidate port..."
}

if ($null -eq $resolvedPort) {
  throw "Unable to find a free AI backend port. Tried: $($candidatePorts -join ', ')."
}

$aiPort = $resolvedPort
$baseUrl = "http://127.0.0.1:$aiPort"
if ($aiPort -ne [string]$Port -and $Port) {
  Write-Host "[ai] requested port $Port was not available; switched to $aiPort"
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
