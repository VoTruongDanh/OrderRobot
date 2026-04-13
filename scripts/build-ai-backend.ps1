$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$serviceRoot = Join-Path $repoRoot 'services/ai-backend'
$distRoot = Join-Path $repoRoot 'dist/desktop/backends'
$workRoot = Join-Path $repoRoot 'dist/desktop/.pyinstaller/ai'
$specRoot = Join-Path $repoRoot 'dist/desktop/specs'

New-Item -ItemType Directory -Force -Path $distRoot, $workRoot, $specRoot | Out-Null

python -m pip install -r (Join-Path $serviceRoot 'requirements.txt') pyinstaller

Set-Location $serviceRoot
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name OrderRobotAiBackend `
  --distpath $distRoot `
  --workpath $workRoot `
  --specpath $specRoot `
  --paths $serviceRoot `
  --collect-submodules app `
  --collect-all faster_whisper `
  --collect-all edge_tts `
  --collect-all numpy `
  --collect-all ctranslate2 `
  --collect-all tokenizers `
  --collect-all onnxruntime `
  --collect-all pyttsx3 `
  --collect-all vieneu `
  run_server.py
