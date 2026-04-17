param(
  [string]$Port,
  [switch]$ForceRestart,
  [switch]$ReuseExisting
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$aiBackendDir = Join-Path $repoRoot 'services\ai-backend'
$devRuntimeDir = Join-Path $repoRoot 'data\dev-runtime'
$aiPortFile = Join-Path $devRuntimeDir 'ai-port.txt'

if (-not (Test-Path $aiBackendDir)) {
  throw "AI backend source not found at: $aiBackendDir"
}

New-Item -ItemType Directory -Force -Path $devRuntimeDir | Out-Null
Remove-Item -LiteralPath $aiPortFile -ErrorAction SilentlyContinue

$aiPort = if ($Port) {
  $Port
} elseif ($env:AI_BACKEND_PORT) {
  $env:AI_BACKEND_PORT
} else {
  '8012'
}
$bindHost = if ($env:DEV_BIND_HOST) {
  [string]$env:DEV_BIND_HOST
} elseif ($env:HOST) {
  [string]$env:HOST
} else {
  '0.0.0.0'
}
$fallbackAiPort = '18012'
$allowReuseExisting = $ReuseExisting.IsPresent -or ($env:AI_DEV_REUSE_EXISTING -ne '0')

# Lite mode: disable bridge/OpenAI calls and keep local speech runtime lean.
$env:LLM_MODE = 'disabled'
if ($env:BRIDGE_BASE_URL) {
  Remove-Item Env:BRIDGE_BASE_URL -ErrorAction SilentlyContinue
}
$env:STT_PRELOAD = 'false'
$env:TTS_PRELOAD = 'false'

function Get-ListenerProcessInfo {
  param(
    [int]$Port
  )

  $portPattern = "^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]|::):$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
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

  return ($Health.llm_mode -eq 'disabled')
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

function Stop-ListenerProcessTree {
  param(
    [object]$Listener,
    [string]$Port
  )

  if ($null -eq $Listener) {
    return
  }

  $listenerPid = [int]$Listener.ProcessId
  try {
    & taskkill /PID $listenerPid /T /F | Out-Null
  } catch {
    try {
      Stop-Process -Id $listenerPid -Force -ErrorAction Stop
    } catch {
      Write-Host "[ai-lite] warning: could not stop pid=${listenerPid}: $($_.Exception.Message)"
    }
  }

  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Milliseconds 200
    $stillUsed = Get-ListenerProcessInfo -Port ([int]$Port)
    if ($null -eq $stillUsed) {
      return
    }
  }
}

function Write-DevRuntimePort {
  param(
    [string]$Port
  )

  New-Item -ItemType Directory -Force -Path $devRuntimeDir | Out-Null
  Set-Content -Path $aiPortFile -Value $Port -Encoding ascii
}

$candidatePorts = @([string]$aiPort)
if ($aiPort -ne $fallbackAiPort) {
  $candidatePorts += $fallbackAiPort
}
$candidatePorts += @('18013', '18014', '18015', '18016')
$candidatePorts = $candidatePorts | Select-Object -Unique

$resolvedAiPort = $null
foreach ($candidatePort in $candidatePorts) {
  $candidateUrl = "http://127.0.0.1:$candidatePort"
  $listener = Get-ListenerProcessInfo -Port ([int]$candidatePort)

  if ($null -eq $listener) {
    $resolvedAiPort = $candidatePort
    break
  }

  Write-Host "[ai-lite] detected existing listener on $candidateUrl (pid=$($listener.ProcessId), process=$($listener.ProcessName))"
  $health = Get-AiHealth -BaseUrl $candidateUrl
  $compatibleLite = Test-AiRuntimeCompatible -Health $health
  if ($compatibleLite -and $allowReuseExisting) {
    Write-DevRuntimePort -Port $candidatePort
    Write-Host "[ai-lite] existing ai-backend is compatible. Reusing current instance."
    exit 0
  }
  if ($compatibleLite -and -not $allowReuseExisting) {
    Write-Host "[ai-lite] existing ai-backend is compatible but reuse is disabled. restarting to load latest code..."
  }

  $shouldAutoRestart = Test-IsAiBackendProcess -Listener $listener
  if ($shouldAutoRestart) {
    Write-Host "[ai-lite] existing listener looks like stale ai-backend. restarting on $candidateUrl ..."
    Stop-ListenerProcessTree -Listener $listener -Port $candidatePort
    $stillUsed = Get-ListenerProcessInfo -Port ([int]$candidatePort)
    if ($null -eq $stillUsed) {
      $resolvedAiPort = $candidatePort
      break
    }
  }

  if ($ForceRestart.IsPresent) {
    Write-Host "[ai-lite] force restart enabled. trying to stop listener on $candidateUrl ..."
    Stop-ListenerProcessTree -Listener $listener -Port $candidatePort
    $stillUsed = Get-ListenerProcessInfo -Port ([int]$candidatePort)
    if ($null -eq $stillUsed) {
      $resolvedAiPort = $candidatePort
      break
    }
  }

  Write-Host "[ai-lite] listener on $candidateUrl is not compatible with current lite stack. Trying next candidate port..."
}

if ($null -eq $resolvedAiPort) {
  throw "Unable to find a free AI backend port. Tried: $($candidatePorts -join ', ')."
}

$aiPort = $resolvedAiPort
$displayHost = if ($bindHost -eq '0.0.0.0') { '0.0.0.0' } else { $bindHost }
$baseUrl = "http://${displayHost}:$aiPort"
if ($aiPort -ne [string]$Port -and $Port) {
  Write-Host "[ai-lite] requested port $Port was not available; switched to $aiPort"
}

Write-Host "[ai-lite] starting ai-backend on $baseUrl"
Write-Host "[ai-lite] LLM_MODE=$env:LLM_MODE (bridge disabled)"
Write-DevRuntimePort -Port $aiPort

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
    --host $bindHost `
    --port $aiPort `
    --app-dir $aiBackendDir
} finally {
  if ($null -ne $previousNativeErrorPreference) {
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }
  $ErrorActionPreference = $previousErrorActionPreference
}
