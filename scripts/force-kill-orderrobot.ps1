$ErrorActionPreference = 'Continue'

Write-Host "Force killing OrderRobot processes..." -ForegroundColor Yellow

# Method 1: taskkill with force
Write-Host "`n[Method 1] Using taskkill /F..." -ForegroundColor Cyan
taskkill /F /IM OrderRobot.exe /T 2>&1 | Out-Null

# Method 2: Stop-Process with Force
Write-Host "[Method 2] Using Stop-Process..." -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -eq "OrderRobot" } | ForEach-Object {
    try {
        Stop-Process -Id $_.Id -Force -ErrorAction Stop
        Write-Host "  Killed OrderRobot (PID: $($_.Id))" -ForegroundColor Green
    } catch {
        Write-Host "  Failed to kill OrderRobot (PID: $($_.Id))" -ForegroundColor Red
    }
}

# Method 3: WMI
Write-Host "[Method 3] Using WMI..." -ForegroundColor Cyan
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq "OrderRobot.exe" } | ForEach-Object {
    try {
        $_.Terminate() | Out-Null
        Write-Host "  Terminated OrderRobot (PID: $($_.ProcessId))" -ForegroundColor Green
    } catch {
        Write-Host "  Failed to terminate OrderRobot (PID: $($_.ProcessId))" -ForegroundColor Red
    }
}

Start-Sleep -Seconds 2

# Check if any process still running
$remaining = Get-Process | Where-Object { $_.ProcessName -eq "OrderRobot" }
if ($remaining) {
    Write-Host "`nWARNING: Some OrderRobot processes still running:" -ForegroundColor Red
    $remaining | Select-Object Id, ProcessName | Format-Table
    Write-Host "Please close them manually in Task Manager (Ctrl+Shift+Esc)" -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "`nAll OrderRobot processes killed successfully!" -ForegroundColor Green
    exit 0
}
