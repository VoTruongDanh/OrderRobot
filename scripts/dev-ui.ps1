param()

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$devRuntimeDir = Join-Path $repoRoot 'data\dev-runtime'
$corePortFile = Join-Path $devRuntimeDir 'core-port.txt'
$aiPortFile = Join-Path $devRuntimeDir 'ai-port.txt'
$uiDir = Join-Path $repoRoot 'apps\kiosk-ui'
$configuredCorePort = if ($env:CORE_BACKEND_PORT) { [string]$env:CORE_BACKEND_PORT } else { '8011' }
$configuredAiPort = if ($env:AI_BACKEND_PORT) { [string]$env:AI_BACKEND_PORT } else { '8012' }
$fallbackCorePorts = @('18011', '18013', '18014', '18015', '18016')
$fallbackAiPorts = @('18012', '18013', '18014', '18015', '18016')

function Test-PortFileReady {
  param(
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    return $false
  }

  try {
    $value = (Get-Content $Path -Raw).Trim()
    return -not [string]::IsNullOrWhiteSpace($value)
  } catch {
    return $false
  }
}

function Get-PortFileValue {
  param(
    [string]$Path
  )

  try {
    return (Get-Content $Path -Raw).Trim()
  } catch {
    return ''
  }
}

function Set-PortFileValue {
  param(
    [string]$Path,
    [string]$Port
  )

  if ([string]::IsNullOrWhiteSpace($Port)) {
    return
  }

  $dir = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Set-Content -Path $Path -Value $Port -Encoding ascii
}

function Test-HealthReady {
  param(
    [string]$Port
  )

  if ([string]::IsNullOrWhiteSpace($Port)) {
    return $false
  }

  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -TimeoutSec 2
    return ($null -ne $response -and $response.status -eq 'ok')
  } catch {
    return $false
  }
}

function Resolve-HealthyPort {
  param(
    [string]$PortFile,
    [string[]]$Candidates
  )

  $allCandidates = @()
  $runtimePort = Get-PortFileValue -Path $PortFile
  if (-not [string]::IsNullOrWhiteSpace($runtimePort)) {
    $allCandidates += $runtimePort
  }
  $allCandidates += $Candidates
  $allCandidates = $allCandidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

  foreach ($candidatePort in $allCandidates) {
    if (Test-HealthReady -Port $candidatePort) {
      Set-PortFileValue -Path $PortFile -Port $candidatePort
      return $candidatePort
    }
  }

  return ''
}

$deadline = (Get-Date).AddSeconds(60)
$resolvedCorePort = ''
$resolvedAiPort = ''
while ((Get-Date) -lt $deadline) {
  $resolvedCorePort = Resolve-HealthyPort -PortFile $corePortFile -Candidates @($configuredCorePort) + $fallbackCorePorts
  $resolvedAiPort = Resolve-HealthyPort -PortFile $aiPortFile -Candidates @($configuredAiPort) + $fallbackAiPorts
  if (-not [string]::IsNullOrWhiteSpace($resolvedCorePort) -and -not [string]::IsNullOrWhiteSpace($resolvedAiPort)) {
    break
  }
  Start-Sleep -Milliseconds 250
}

if ([string]::IsNullOrWhiteSpace($resolvedCorePort)) {
  Write-Host "[dev-ui] warning: core-backend not healthy before timeout; Vite may start with degraded proxy routing."
}
if ([string]::IsNullOrWhiteSpace($resolvedAiPort)) {
  Write-Host "[dev-ui] warning: ai-backend not healthy before timeout; Vite may start with degraded proxy routing."
}

Set-Location $uiDir
& npm run dev:with-models
