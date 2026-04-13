$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Join-Path $repoRoot 'services/core-backend'
$distRoot = Join-Path $repoRoot 'dist/desktop/backends'
$workRoot = Join-Path $repoRoot 'dist/desktop/.pyinstaller/core'
$specRoot = Join-Path $repoRoot 'dist/desktop/specs'

New-Item -ItemType Directory -Force -Path $distRoot, $workRoot, $specRoot | Out-Null

python -m pip install -r (Join-Path $serviceRoot 'requirements.txt') pyinstaller

Set-Location $serviceRoot
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name OrderRobotCoreBackend `
  --distpath $distRoot `
  --workpath $workRoot `
  --specpath $specRoot `
  --paths $serviceRoot `
  --collect-submodules app `
  run_server.py
