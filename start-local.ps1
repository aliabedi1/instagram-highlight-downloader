$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonExe = Join-Path $ProjectRoot '.venv\Scripts\python.exe'

Set-Location $ProjectRoot

if (-not (Test-Path $PythonExe)) {
  Write-Host 'Preparing the local downloader for first use...'
  python -m venv .venv
  & $PythonExe -m pip install --disable-pip-version-check -r requirements.txt
}

$Backend = Start-Process -FilePath $PythonExe `
  -ArgumentList '-m', 'uvicorn', 'local_backend.app:app', '--host', '127.0.0.1', '--port', '8787' `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -PassThru

$env:WRANGLER_LOG_PATH = '.wrangler/wrangler.log'

try {
  Write-Host ''
  Write-Host 'Keepsake is starting at http://localhost:3000' -ForegroundColor Magenta
  Write-Host 'Press Ctrl+C to stop it.'
  npx vinext dev
}
finally {
  Stop-Process -Id $Backend.Id -Force -ErrorAction SilentlyContinue
}
