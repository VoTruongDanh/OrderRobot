$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopDist = Join-Path $repoRoot 'dist/desktop'
$winUnpackedDir = Join-Path $desktopDist 'installer-new/win-unpacked'

function Stop-LockingDesktopProcesses {
  param(
    [string]$unpackedDir
  )

  $targets = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $path = ''
    try {
      $path = [string]$_.Path
    } catch {}

    if ($_.ProcessName -eq 'OrderRobot') {
      return $true
    }

    if ([string]::IsNullOrWhiteSpace($path)) {
      return $false
    }

    return $path.StartsWith($unpackedDir, [System.StringComparison]::OrdinalIgnoreCase)
  }

  foreach ($proc in $targets) {
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop
      Write-Host ("Stopped desktop process: {0} ({1})" -f $proc.ProcessName, $proc.Id)
    } catch {
      Write-Warning ("Could not stop process {0} ({1}): {2}" -f $proc.ProcessName, $proc.Id, $_.Exception.Message)
    }
  }

  if ($targets) {
    Start-Sleep -Milliseconds 800
  }
}

if (Test-Path $desktopDist) {
  Stop-LockingDesktopProcesses -unpackedDir $winUnpackedDir
  Remove-Item -Recurse -Force -LiteralPath $desktopDist
}

Write-Host "Desktop build artifacts cleaned:" $desktopDist
