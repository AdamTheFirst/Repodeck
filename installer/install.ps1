<#
  git-helper installer for Windows 10/11. Runs under Windows PowerShell 5.1.

  What it does, in order, asking before anything is downloaded:
    1. Checks for Git, GitHub CLI and Node.js; offers to install the missing ones with winget.
    2. Copies git-helper to %LOCALAPPDATA%\Programs\git-helper (no admin rights needed).
    3. Creates Start menu and desktop shortcuts and an "Apps & features" entry for uninstalling.
  Re-running it upgrades in place and keeps your settings. Nothing is sent anywhere by this script.

  Options:
    -Yes            answer yes to every question (unattended)
    -InstallDir     install somewhere else
    -NoShortcuts    do not create shortcuts
    -NoRegistry     do not add an uninstall entry
    -SkipTools      do not check or install Git / GitHub CLI / Node.js
    -NoLaunch       do not offer to start git-helper at the end
    -PlanOnly       show which tools would be installed, then stop without changing anything
    -SimulateMissing git,gh,node   treat these tools as missing (for testing the install path; combine with -PlanOnly)
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\git-helper'),
  [string]$ShortcutDir = '',
  [switch]$NoShortcuts,
  [switch]$NoRegistry,
  [switch]$SkipTools,
  [switch]$NoLaunch,
  [switch]$PlanOnly,
  [string[]]$SimulateMissing = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
# "-File" passes "a,b" as one string; accept both forms.
$SimulateMissing = @($SimulateMissing | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$Source = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:LOCALAPPDATA 'git-helper'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$LogFile = Join-Path $DataDir 'install.log'
$summary = New-Object System.Collections.ArrayList

function Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}
function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color; Log $msg }
function Step([string]$msg) { Write-Host ''; Say "== $msg" 'Cyan' }
function Done([string]$msg) { Say "   OK  $msg" 'Green'; [void]$summary.Add("OK    $msg") }
function Warn([string]$msg) { Say "   !!  $msg" 'Yellow'; [void]$summary.Add("WARN  $msg") }
function Fail([string]$msg) { Say "   XX  $msg" 'Red'; [void]$summary.Add("FAIL  $msg") }
function Ask([string]$question) {
  if ($Yes) { Log "$question -> yes (-Yes)"; return $true }
  $a = Read-Host "$question [Y/n]"
  $ok = ($a -eq '' -or $a -match '^(y|yes)$')
  Log "$question -> $a"
  return $ok
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-ToolVersion([string]$exe, [string[]]$versionArgs, [string]$pattern) {
  $cmd = Get-Command $exe -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try {
    $out = & $cmd.Source @versionArgs 2>$null | Out-String
    $m = [regex]::Match($out, $pattern)
    if ($m.Success) { return [version]$m.Groups[1].Value }
  } catch { }
  return [version]'0.0'
}

$Tools = @(
  @{ Name = 'Git'; Exe = 'git'; Args = @('--version'); Pattern = '(\d+\.\d+\.\d+)'; Min = [version]'2.30.0'; Winget = 'Git.Git' },
  @{ Name = 'GitHub CLI'; Exe = 'gh'; Args = @('--version'); Pattern = '(\d+\.\d+\.\d+)'; Min = [version]'2.40.0'; Winget = 'GitHub.cli' },
  @{ Name = 'Node.js'; Exe = 'node'; Args = @('--version'); Pattern = 'v(\d+\.\d+\.\d+)'; Min = [version]'20.0.0'; Winget = 'OpenJS.NodeJS.LTS' }
)

Say "git-helper installer  (log: $LogFile)" 'White'
Log "Source: $Source  InstallDir: $InstallDir  PowerShell $($PSVersionTable.PSVersion)"

if (-not (Test-Path (Join-Path $Source 'server\main.js'))) {
  Fail "This script must be run from the installer folder of a git-helper copy (server\main.js not found next to it)."
  exit 1
}

# ---------------------------------------------------------------- tools
if (-not $SkipTools) {
  Step 'Checking required tools'
  Refresh-Path
  $missing = @()
  foreach ($t in $Tools) {
    $v = Get-ToolVersion $t.Exe $t.Args $t.Pattern
    if ($SimulateMissing -contains $t.Exe) { $v = $null }
    if ($null -eq $v) { Say ("   {0}: not installed" -f $t.Name); $missing += $t }
    elseif ($v -lt $t.Min) { Say ("   {0}: version {1} is older than {2}" -f $t.Name, $v, $t.Min) 'Yellow'; $missing += $t }
    else { Done ("{0} {1}" -f $t.Name, $v) }
  }
  if ($missing.Count -gt 0) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
      Fail 'winget (App Installer) is not available, so the missing tools cannot be installed automatically.'
      Say '   Install "App Installer" from the Microsoft Store (https://apps.microsoft.com/detail/9NBLGGH4NNS1), then run this installer again.'
      Say ('   Or install these yourself and run again: ' + (($missing | ForEach-Object { $_.Name }) -join ', '))
      exit 1
    }
    Say ''
    Say 'These will be downloaded and installed with winget (from the official winget source):' 'White'
    foreach ($t in $missing) { Say ("   - {0}  (winget id {1})" -f $t.Name, $t.Winget) 'White' }
    Say '   winget may show a Windows permission prompt for tools that install for all users.'
    if ($PlanOnly) { Say 'Plan only (-PlanOnly): nothing was installed.' 'White'; exit 0 }
    if (-not (Ask 'Install them now?')) { Fail 'Required tools are missing. Nothing was installed.'; exit 1 }
    foreach ($t in $missing) {
      Say ("   Installing {0}..." -f $t.Name)
      $wargs = @('install', '--id', $t.Winget, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent')
      if ((Get-ToolVersion $t.Exe $t.Args $t.Pattern)) { $wargs[0] = 'upgrade' }
      & $winget.Source @wargs
      Log ("winget {0} exited with {1}" -f ($wargs -join ' '), $LASTEXITCODE)
    }
    Refresh-Path
    foreach ($t in $missing) {
      # winget sometimes needs a moment, and PATH may only update for new processes
      $v = Get-ToolVersion $t.Exe $t.Args $t.Pattern
      if ($null -eq $v) {
        $guess = @{ 'git' = "$env:ProgramFiles\Git\cmd"; 'gh' = "$env:ProgramFiles\GitHub CLI"; 'node' = "$env:ProgramFiles\nodejs" }[$t.Exe]
        if ($guess -and (Test-Path $guess)) { $env:Path = "$guess;$env:Path"; $v = Get-ToolVersion $t.Exe $t.Args $t.Pattern }
      }
      if ($null -eq $v -or $v -lt $t.Min) { Fail ("{0} still not usable after installing. Open a new terminal or sign out and in, then run this installer again." -f $t.Name); exit 1 }
      Done ("{0} {1} installed" -f $t.Name, $v)
    }
  }
} else { Say 'Skipping tool checks (-SkipTools)' }
if ($PlanOnly) { Say 'Plan only (-PlanOnly): all tools present, nothing to install.' 'White'; exit 0 }

# ---------------------------------------------------------------- edge
Step 'Checking for Microsoft Edge (used for the app window)'
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { Done 'Microsoft Edge found' } else { Warn 'Microsoft Edge not found. git-helper will open in your default browser instead.' }

# ---------------------------------------------------------------- copy
Step "Installing git-helper to $InstallDir"
$instanceFile = Join-Path $DataDir 'instance.json'
if (Test-Path $instanceFile) {
  try {
    $inst = Get-Content $instanceFile -Raw | ConvertFrom-Json
    $body = '{"method":"app.quit"}'
    Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/rpc" -f $inst.port) -Method Post -Body $body -ContentType 'application/json' -Headers @{ 'X-Token' = $inst.token } -TimeoutSec 3 | Out-Null
    Say '   Stopped the running git-helper so it can be updated.'
    Start-Sleep -Milliseconds 800
  } catch { Log "No running instance answered: $($_.Exception.Message)" }
}
$isUpgrade = Test-Path (Join-Path $InstallDir 'server\main.js')
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($d in @('server', 'ui', 'installer')) {
  $target = Join-Path $InstallDir $d
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse -Force (Join-Path $Source $d) $target
}
foreach ($f in @('package.json', 'LICENSE', 'README.md', 'SECURITY.md')) {
  $p = Join-Path $Source $f
  if (Test-Path $p) { Copy-Item -Force $p (Join-Path $InstallDir $f) }
}
$launcher = Join-Path $InstallDir 'installer\launch.ps1'
Done ($(if ($isUpgrade) { 'Updated existing installation (settings kept)' } else { 'Files copied' }))

# ---------------------------------------------------------------- shortcuts
$icon = Join-Path $InstallDir 'installer\git-helper.ico'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function New-Shortcut([string]$path) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = $psExe
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
  $s.WorkingDirectory = $InstallDir
  $s.IconLocation = "$icon,0"
  $s.WindowStyle = 7
  $s.Description = 'git-helper: repositories, pull requests and GitHub Actions'
  $s.Save()
}
if (-not $NoShortcuts) {
  Step 'Creating shortcuts'
  $startDir = if ($ShortcutDir) { $ShortcutDir } else { Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
  $deskDir = if ($ShortcutDir) { $ShortcutDir } else { [Environment]::GetFolderPath('Desktop') }
  New-Item -ItemType Directory -Force -Path $startDir | Out-Null
  New-Shortcut (Join-Path $startDir 'git-helper.lnk'); Done 'Start menu shortcut'
  if ($ShortcutDir -or (Ask 'Create a desktop shortcut too?')) { New-Shortcut (Join-Path $deskDir 'git-helper.lnk'); Done 'Desktop shortcut' }
}

# ---------------------------------------------------------------- uninstall entry
if (-not $NoRegistry) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\git-helper'
  $version = '0.0.0'
  try { $version = (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version } catch { }
  New-Item -Path $key -Force | Out-Null
  $props = @{
    DisplayName = 'git-helper'; DisplayVersion = $version; Publisher = 'git-helper'; InstallLocation = $InstallDir; DisplayIcon = $icon
    UninstallString = "`"$psExe`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'installer\uninstall.ps1')`""
  }
  foreach ($k in $props.Keys) { Set-ItemProperty -Path $key -Name $k -Value $props[$k] }
  Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord
  Done 'Uninstall entry added (Settings > Apps > Installed apps)'
}

# ---------------------------------------------------------------- done
Step 'Summary'
foreach ($s in $summary) { Write-Host "   $s" }
Log ($summary -join ' | ')
Say "Installed to $InstallDir. Full log: $LogFile" 'White'
Say 'Sign in to GitHub inside git-helper: use the button at the top right. No sign-in is needed to install.' 'White'
if (-not $NoLaunch -and -not $Yes -and (Ask 'Start git-helper now?')) {
  Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$launcher`"") -WindowStyle Hidden
}
exit 0
