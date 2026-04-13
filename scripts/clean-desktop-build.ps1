$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopDist = Join-Path $repoRoot 'dist/desktop'

if (Test-Path $desktopDist) {
  Remove-Item -Recurse -Force -LiteralPath $desktopDist
}

Write-Host "Desktop build artifacts cleaned:" $desktopDist
