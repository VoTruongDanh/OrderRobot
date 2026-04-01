param(
  [string]$Port,
  [switch]$ForceRestart,
  [switch]$ReuseExisting
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
$allowReuseExisting = $ReuseExisting.IsPresent -or ($env:AI_DEV_REUSE_EXISTING -eq '1')

# Force bridge-only defaults for local dev unless user explicitly overrides.
if (-not $env:LLM_MODE) {
  $env:LLM_MODE = 'bridge_only'
}
if (-not $env:BRIDGE_BASE_URL) {
  $env:BRIDGE_BASE_URL = 'http://127.0.0.1:1122'
}
# Prefer VieNeu realtime TTS by default for local kiosk voice.
if (-not $env:TTS_ENGINE) {
  $env:TTS_ENGINE = 'vieneu'
}

function Get-ListenerProcessInfo {
  param(
    [int]$Port
  )

  # NOTE:
  # Get-NetTCPConnection can hang on some Windows builds/environments.
  # Use netstat parsing for deterministic behavior during local dev boot.
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
  if (-not ($hasTtsEngine -and $hasSttModel)) {
    return $false
  }

  # Require newer VieNeu-capable health schema when engine is vieneu.
  $ttsEngine = [string]$Health.tts_engine
  if ($ttsEngine -eq 'vieneu') {
    $hasVieneuInstalledFlag = $Health.PSObject.Properties.Name -contains 'vieneu_installed'
    if (-not $hasVieneuInstalledFlag) {
      return $false
    }
  }

  return $true
}

function Test-IsAiBackendProcess {
  param(
    [object]$Listener
  )

  if ($null -eq $Listener) {
    return $false
  }

  $commandLine = [string]$Listener.CommandLine
  if (-not [string]::IsNullOrWhiteSpace($commandLine)) {
    if ($commandLine -match 'services\\ai-backend' -or $commandLine -match 'app\.main:app' -or $commandLine -match 'uvicorn') {
      return $true
    }
  }

  $processName = [string]$Listener.ProcessName
  return ($processName -match 'python')
}

$candidatePorts = @([string]$aiPort)
if ($aiPort -ne $fallbackAiPort) {
  $candidatePorts += $fallbackAiPort
}
# Extra fallback ports to avoid being blocked by stale listeners on 8012/18012.
$candidatePorts += @('18013', '18014', '18015', '18016')
$candidatePorts = $candidatePorts | Select-Object -Unique

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
  if ($compatibleBridge -and $allowReuseExisting) {
    Write-Host "[ai] existing ai-backend is compatible (realtime + bridge_only). Reusing current instance."
    exit 0
  }
  if ($compatibleBridge -and -not $allowReuseExisting) {
    Write-Host "[ai] existing ai-backend is compatible but reuse is disabled. restarting to load latest code..."
  }

  $shouldAutoRestart = (Test-IsAiBackendProcess -Listener $listener)
  if ($shouldAutoRestart) {
    Write-Host "[ai] existing listener looks like outdated ai-backend. restarting on $candidateUrl ..."
    try {
      Stop-Process -Id $listener.ProcessId -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 700
    } catch {
      Write-Host "[ai] warning: could not stop pid=$($listener.ProcessId): $($_.Exception.Message)"
    }

    $stillUsed = Get-ListenerProcessInfo -Port ([int]$candidatePort)
    if ($null -eq $stillUsed) {
      $resolvedPort = $candidatePort
      break
    }
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

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$previousNativeErrorPreference = $null
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
}
try {
  & python -m uvicorn app.main:app `
    --reload `
    --reload-dir $aiBackendDir `
    --reload-dir $dataDir `
    --port $aiPort `
    --app-dir $aiBackendDir
} finally {
  if ($null -ne $previousNativeErrorPreference) {
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }
  $ErrorActionPreference = $previousErrorActionPreference
}
