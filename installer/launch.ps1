# Starts git-helper without a console window, or brings up the window of the running copy.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$main = Join-Path $root 'server\main.js'

# PATH of a process started from a shortcut may predate tool installs; read the current one.
$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join ';'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) { if (Test-Path $p) { $node = Get-Item $p; break } }
}
if (-not $node) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('Node.js was not found. Run the git-helper installer again to install it.', 'git-helper') | Out-Null
  exit 1
}
$exe = if ($node.PSObject.Properties['Source']) { $node.Source } else { $node.FullName }
Start-Process -FilePath $exe -ArgumentList @("`"$main`"") -WorkingDirectory $root -WindowStyle Hidden
