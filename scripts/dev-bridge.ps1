param(
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'

Write-Host "Starting Standalone Bridge Server (No Docker)"
Write-Host "Node version: $(node -v)"

$env:PORT = if ($env:BRIDGE_GATEWAY_PORT) { $env:BRIDGE_GATEWAY_PORT } else { '1122' }
$env:HOST = '127.0.0.1'

# Start the Node script directly
node scripts/bridge-server.mjs
