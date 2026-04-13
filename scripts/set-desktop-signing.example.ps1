$env:WIN_CSC_LINK = "C:\certs\OrderRobot-CodeSign.pfx"
$env:WIN_CSC_KEY_PASSWORD = "doi-mat-khau-cert"
$env:WIN_PUBLISHER_NAME = "CNX"

Write-Host "Desktop code signing variables loaded for this PowerShell session."
Write-Host "Run: npm run build:desktop"
