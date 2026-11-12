<#
  Builds the release files into dist\:
    git-helper.exe                  launcher (no console window)
    git-helper-setup-<version>.exe  GUI installer with Install, Repair and Uninstall

  Uses the C# compiler that ships with Windows (.NET Framework 4.x), so there is nothing to install
  to build, and the resulting exes run on a clean Windows 10/11.
  Works in Windows PowerShell 5.1 and PowerShell 7:   powershell -File scripts\build.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'The .NET Framework C# compiler (csc.exe) was not found.' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$icon = Join-Path $root 'installer\git-helper.ico'
$manifest = Join-Path $root 'installer\src\app.manifest'

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "Building git-helper $version"

# 1. launcher
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$icon" "/out:$stage\git-helper.exe" /r:System.Windows.Forms.dll (Join-Path $root 'installer\src\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }

# 2. payload
foreach ($d in 'server', 'ui') { Copy-Item -Recurse (Join-Path $root $d) (Join-Path $stage $d) }
foreach ($f in 'package.json', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md') { $p = Join-Path $root $f; if (Test-Path $p) { Copy-Item $p $stage } }
Copy-Item $icon $stage
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $dist 'payload.zip'
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

# 3. setup
$buildInfo = Join-Path $dist 'BuildInfo.cs'
Set-Content -Path $buildInfo -Encoding UTF8 -Value "static class BuildInfo { public const string Version = `"$version`"; }"
$setup = Join-Path $dist "git-helper-setup-$version.exe"
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$icon" "/win32manifest:$manifest" "/resource:$zip,payload.zip" "/out:$setup" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  (Join-Path $root 'installer\src\Setup.cs') $buildInfo
if ($LASTEXITCODE -ne 0) { throw 'Setup build failed.' }

Copy-Item (Join-Path $stage 'git-helper.exe') $dist
Remove-Item -Recurse -Force $stage, $zip, $buildInfo
Get-ChildItem $dist | ForEach-Object { '{0,-36} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB) }
