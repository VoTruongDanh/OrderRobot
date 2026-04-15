param(
  [switch]$UnpackedOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$hasWindowsCodeSigning = -not [string]::IsNullOrWhiteSpace($env:WIN_CSC_LINK)
$builderTarget = if ($UnpackedOnly) { 'dir' } else { 'nsis' }
$builderArgs = @('--config', 'desktop/electron-builder.json', '--win', $builderTarget)

if ($hasWindowsCodeSigning) {
  Write-Host "Windows code signing: enabled"
  if ([string]::IsNullOrWhiteSpace($env:CSC_IDENTITY_AUTO_DISCOVERY)) {
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'true'
  }

  $builderArgs += '-c.win.signAndEditExecutable=true'
  $builderArgs += '-c.win.forceCodeSigning=true'

  if (-not [string]::IsNullOrWhiteSpace($env:WIN_PUBLISHER_NAME)) {
    $builderArgs += "-c.win.publisherName=$($env:WIN_PUBLISHER_NAME)"
    Write-Host "Windows publisherName: $($env:WIN_PUBLISHER_NAME)"
  }
} else {
  Write-Host "Windows code signing: disabled (WIN_CSC_LINK not set)"
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  $env:WIN_CSC_LINK = ''
  $env:WIN_CSC_KEY_PASSWORD = ''
  $env:WIN_PUBLISHER_NAME = ''
}

if ($UnpackedOnly) {
  Write-Host "Desktop target: win-unpacked only (installer skipped to reduce disk usage)"
}

npm run build:ui
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-core-backend.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-ai-backend.ps1
node scripts/patch-electron-builder-nsis.mjs
npx electron-builder @builderArgs
