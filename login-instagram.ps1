param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._]{1,30}$')]
  [string]$InstagramUsername
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonExe = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$SessionDirectory = Join-Path $ProjectRoot '.sessions'
$SessionFile = Join-Path $SessionDirectory "session-$InstagramUsername"

New-Item -ItemType Directory -Path $SessionDirectory -Force | Out-Null

Write-Host ''
Write-Host 'Keepsake — Connect Instagram' -ForegroundColor Magenta
Write-Host 'Instagram requires a viewer session to list highlights, including public ones.'
Write-Host 'Your password is entered only into Instaloader in this terminal and is not saved by Keepsake.'
Write-Host ''

& $PythonExe -m instaloader --login $InstagramUsername --sessionfile $SessionFile

if ($LASTEXITCODE -eq 0 -and (Test-Path $SessionFile)) {
  Write-Host ''
  Write-Host 'Connected successfully. Return to Keepsake and click Refresh sessions.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host 'Login was not completed. You can close this window and try again.' -ForegroundColor Yellow
}
