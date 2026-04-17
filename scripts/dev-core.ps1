param(
  [string]$Port,
  [switch]$ForceRestart,
  [switch]$ReuseExisting
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$coreBackendDir = Join-Path $repoRoot 'services\core-backend'
$devRuntimeDir = Join-Path $repoRoot 'data\dev-runtime'
$corePortFile = Join-Path $devRuntimeDir 'core-port.txt'

if (-not (Test-Path $coreBackendDir)) {
  throw "Core backend source not found at: $coreBackendDir"
}

New-Item -ItemType Directory -Force -Path $devRuntimeDir | Out-Null
Remove-Item -LiteralPath $corePortFile -ErrorAction SilentlyContinue

$corePort = if ($Port) {
  $Port
} elseif ($env:CORE_BACKEND_PORT) {
  $env:CORE_BACKEND_PORT
} else {
  '8011'
}
$bindHost = if ($env:DEV_BIND_HOST) {
  [string]$env:DEV_BIND_HOST
} elseif ($env:HOST) {
  [string]$env:HOST
} else {
  '0.0.0.0'
}
$fallbackCorePort = '18011'
$allowReuseExisting = $ReuseExisting.IsPresent -or ($env:CORE_DEV_REUSE_EXISTING -ne '0')

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
    [object]$Health
  )

  if ($null -eq $Health) {
    return $false
  }

  return ($Health.status -eq 'ok')
}

function Test-IsCoreBackendProcess {
  param(
    [object]$Listener
  )

  if ($null -eq $Listener) {
    return $false
  }

  $commandLine = [string]$Listener.CommandLine
  if (-not [string]::IsNullOrWhiteSpace($commandLine)) {
    if ($commandLine -match 'services\\core-backend' -or $commandLine -match 'app\.main:app' -or $commandLine -match 'uvicorn') {
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
      Write-Host "[core] warning: could not stop pid=${listenerPid}: $($_.Exception.Message)"
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
  Set-Content -Path $corePortFile -Value $Port -Encoding ascii
}

$candidatePorts = @([string]$corePort)
if ($corePort -ne $fallbackCorePort) {
  $candidatePorts += $fallbackCorePort
}
$candidatePorts += @('18013', '18014', '18015', '18016')
$candidatePorts = $candidatePorts | Select-Object -Unique

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
  $compatibleCore = Test-CoreRuntimeCompatible -Health $health
  if ($compatibleCore -and $allowReuseExisting) {
    Write-DevRuntimePort -Port $candidatePort
    Write-Host "[core] existing core-backend is compatible. Reusing current instance."
    exit 0
  }
  if ($compatibleCore -and -not $allowReuseExisting) {
    Write-Host "[core] existing core-backend is compatible but reuse is disabled. restarting to load latest code..."
  }

  $shouldAutoRestart = Test-IsCoreBackendProcess -Listener $listener
  if ($shouldAutoRestart) {
    Write-Host "[core] existing listener looks like stale core-backend. restarting on $candidateUrl ..."
    Stop-ListenerProcessTree -Listener $listener -Port $candidatePort
    $stillUsed = Get-ListenerProcessInfo -Port ([int]$candidatePort)
    if ($null -eq $stillUsed) {
      $resolvedCorePort = $candidatePort
      break
    }
  }

  if ($ForceRestart.IsPresent) {
    Write-Host "[core] force restart enabled. trying to stop listener on $candidateUrl ..."
    Stop-ListenerProcessTree -Listener $listener -Port $candidatePort
    $stillUsed = Get-ListenerProcessInfo -Port ([int]$candidatePort)
    if ($null -eq $stillUsed) {
      $resolvedCorePort = $candidatePort
      break
    }
  }

  Write-Host "[core] listener on $candidateUrl is not compatible with current core stack. Trying next candidate port..."
}

if ($null -eq $resolvedCorePort) {
  throw "Unable to find a free Core backend port. Tried: $($candidatePorts -join ', ')."
}

$corePort = $resolvedCorePort
$displayHost = if ($bindHost -eq '0.0.0.0') { '0.0.0.0' } else { $bindHost }
$baseUrl = "http://${displayHost}:$corePort"
if ($corePort -ne [string]$Port -and $Port) {
  Write-Host "[core] requested port $Port was not available; switched to $corePort"
}

Write-Host "[core] starting core-backend on $baseUrl"
Write-DevRuntimePort -Port $corePort

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
    --reload-dir $coreBackendDir `
    --host $bindHost `
    --port $corePort `
    --app-dir $coreBackendDir
} finally {
  if ($null -ne $previousNativeErrorPreference) {
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }
  $ErrorActionPreference = $previousErrorActionPreference
}
