$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$exePath = Join-Path $repoRoot 'dist\desktop\installer-new\win-unpacked\OrderRobot.exe'
$logDir = Join-Path $env:APPDATA 'OrderRobot\logs'
$bootstrapLog = Join-Path $logDir 'desktop-bootstrap.log'
$runtimeLog = Join-Path $logDir 'desktop-runtime.log'

Write-Host "Repo root: $repoRoot"
Write-Host "Desktop exe: $exePath"

if (-not (Test-Path $exePath)) {
  throw "Khong tim thay OrderRobot.exe tai $exePath. Hay build desktop truoc."
}

Get-Process |
  Where-Object { $_.ProcessName -eq 'OrderRobot' -or $_.ProcessName -like 'order-robot-demo*' } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Remove-Item -Force -LiteralPath $bootstrapLog,$runtimeLog -ErrorAction SilentlyContinue

Write-Host 'Launching desktop app...'
$process = Start-Process -FilePath $exePath -PassThru
Start-Sleep -Seconds 5

$alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
if ($alive) {
  Write-Host "Process still running: PID=$($process.Id)"
} else {
  $process.Refresh()
  Write-Host "Process exited: PID=$($process.Id) ExitCode=$($process.ExitCode)"
}

Write-Host "`n--- desktop-bootstrap.log ---"
if (Test-Path $bootstrapLog) {
  Get-Content -Path $bootstrapLog -Tail 120
} else {
  Write-Host 'No bootstrap log created.'
}

Write-Host "`n--- desktop-runtime.log ---"
if (Test-Path $runtimeLog) {
  Get-Content -Path $runtimeLog -Tail 120
} else {
  Write-Host 'No runtime log created.'
}
