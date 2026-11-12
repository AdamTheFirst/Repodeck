<#
  Removes git-helper: stops it, deletes the program folder, shortcuts and the uninstall entry.
  Asks before deleting settings, logs and safety copies of discarded changes.
  Git, GitHub CLI and Node.js are left installed.
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$KeepData,
  [string]$InstallDir = '',
  [string]$ShortcutDir = ''
)
$ErrorActionPreference = 'Continue'
if (-not $InstallDir) { $InstallDir = Split-Path -Parent $PSScriptRoot }
$DataDir = Join-Path $env:LOCALAPPDATA 'git-helper'

function Ask([string]$q) { if ($Yes) { return $true }; $a = Read-Host "$q [y/N]"; return ($a -match '^(y|yes)$') }

if (-not (Test-Path (Join-Path $InstallDir 'server\main.js'))) {
  Write-Host "git-helper does not look installed in $InstallDir; nothing removed." -ForegroundColor Yellow
  exit 1
}
if (-not $Yes) {
  Write-Host "This removes git-helper from $InstallDir." -ForegroundColor White
  if (-not (Ask 'Continue?')) { exit 0 }
}

# stop a running copy
$instanceFile = Join-Path $DataDir 'instance.json'
if (Test-Path $instanceFile) {
  try {
    $inst = Get-Content $instanceFile -Raw | ConvertFrom-Json
    Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/rpc" -f $inst.port) -Method Post -Body '{"method":"app.quit"}' -ContentType 'application/json' -Headers @{ 'X-Token' = $inst.token } -TimeoutSec 3 | Out-Null
    Start-Sleep -Milliseconds 800
  } catch { }
}

$startDir = if ($ShortcutDir) { $ShortcutDir } else { Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
$deskDir = if ($ShortcutDir) { $ShortcutDir } else { [Environment]::GetFolderPath('Desktop') }
foreach ($lnk in @((Join-Path $startDir 'git-helper.lnk'), (Join-Path $deskDir 'git-helper.lnk'))) { if (Test-Path $lnk) { Remove-Item -Force $lnk; Write-Host "Removed $lnk" } }
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\git-helper' -Recurse -Force -ErrorAction SilentlyContinue

# The uninstaller runs from inside the folder it deletes; copy-and-delete from a temp location is not needed
# because PowerShell has already loaded this script.
Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) { Write-Host "Some files in $InstallDir could not be removed (in use?). Delete the folder manually." -ForegroundColor Yellow }
else { Write-Host "Removed $InstallDir" }

if (-not $KeepData -and (Test-Path $DataDir)) {
  Write-Host ''
  Write-Host "Settings, logs and safety copies of discarded changes are in $DataDir." -ForegroundColor White
  if (Ask 'Delete them too? (Safety copies cannot be restored afterwards)') { Remove-Item -Recurse -Force $DataDir; Write-Host "Removed $DataDir" }
  else { Write-Host 'Kept your settings.' }
}
Write-Host ''
Write-Host 'git-helper was removed. Git, GitHub CLI and Node.js are still installed.' -ForegroundColor Green
