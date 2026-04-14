$ErrorActionPreference = 'Stop'

Write-Host "Restarting Windows Explorer to release file locks..." -ForegroundColor Yellow

# Kill Explorer
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Start Explorer again
Start-Process explorer.exe
Start-Sleep -Seconds 2

Write-Host "Explorer restarted. Attempting to delete win-unpacked..." -ForegroundColor Cyan

# Try to delete
Remove-Item "dist/desktop/installer/win-unpacked" -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path "dist/desktop/installer/win-unpacked") {
    Write-Host "Still cannot delete. Please restart your computer." -ForegroundColor Red
    exit 1
} else {
    Write-Host "Successfully deleted win-unpacked!" -ForegroundColor Green
    Write-Host "Now running build..." -ForegroundColor Cyan
    
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    npm run build:desktop
}
