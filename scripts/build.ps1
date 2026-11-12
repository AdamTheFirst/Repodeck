<#
  Builds the release files into dist\:
    Repodeck.exe                  launcher (no console window)
    RepodeckSetup-<version>.exe  GUI installer with Install, Repair and Uninstall

  Uses the C# compiler that ships with Windows (.NET Framework 4.x), so there is nothing to install
  to build, and the resulting exes run on a clean Windows 10/11.
  Works in Windows PowerShell 5.1 and PowerShell 7:   powershell -File scripts\build.ps1

  -SignedApp <file>  Put this already code-signed Repodeck.exe inside Setup instead of compiling one.
                     The release workflow signs the app first, then builds Setup around it.
                     The file must be outside dist\, which is emptied at the start.
#>
param([string]$SignedApp, [string]$Out)
$ErrorActionPreference = 'Stop'
if ($SignedApp) { $SignedApp = (Resolve-Path $SignedApp).Path }
$root = Split-Path -Parent $PSScriptRoot
$dist = if ($Out) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out) } else { Join-Path $root 'dist' }  # -Out: build somewhere else, e.g. while dist\ is in use
$stage = Join-Path $dist 'stage'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'The .NET Framework C# compiler (csc.exe) was not found.' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$icon = Join-Path $root 'installer\repodeck.ico'
$manifest = Join-Path $root 'installer\src\app.manifest'

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "Building Repodeck $version"

# 0. Microsoft's WebView2 SDK (the app window). Downloaded once from nuget.org, pinned by version and hash.
$wvVersion = '1.0.4314.35'
$wvHash = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
$wv = Join-Path $root "installer\vendor\webview2-$wvVersion"
if (-not (Test-Path (Join-Path $wv 'Microsoft.Web.WebView2.Core.dll'))) {
  $tmp = Join-Path $root 'installer\vendor\dl'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $pkg = Join-Path $tmp 'webview2.nupkg'
  if (-not (Test-Path $pkg)) {
    Write-Host "Downloading Microsoft.Web.WebView2 $wvVersion"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    (New-Object Net.WebClient).DownloadFile("https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$wvVersion/microsoft.web.webview2.$wvVersion.nupkg", $pkg)
  }
  if ((Get-FileHash $pkg -Algorithm SHA256).Hash.ToLower() -ne $wvHash) { throw 'The WebView2 package does not match the pinned hash.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $x = Join-Path $tmp 'x'
  if (Test-Path $x) { Remove-Item -Recurse -Force $x }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($pkg, $x)
  New-Item -ItemType Directory -Force -Path $wv | Out-Null
  Copy-Item (Join-Path $x 'lib\net462\Microsoft.Web.WebView2.Core.dll'), (Join-Path $x 'lib\net462\Microsoft.Web.WebView2.WinForms.dll') $wv
  Copy-Item (Join-Path $x 'LICENSE.txt') (Join-Path $wv 'WebView2-LICENSE.txt')
  foreach ($a in 'win-x64', 'win-x86', 'win-arm64') {
    New-Item -ItemType Directory -Force -Path (Join-Path $wv "runtimes\$a\native") | Out-Null
    Copy-Item (Join-Path $x "runtimes\$a\native\WebView2Loader.dll") (Join-Path $wv "runtimes\$a\native")
  }
  Remove-Item -Recurse -Force $tmp
}

# Product name and version inside each exe: shown under Properties > Details, and checked when the files are code-signed.
function New-AssemblyInfo([string]$file, [string]$title) {
  Set-Content -Path $file -Encoding UTF8 -Value @(
    'using System.Reflection;',
    "[assembly: AssemblyTitle(`"$title`")]",
    '[assembly: AssemblyProduct("Repodeck")]',
    '[assembly: AssemblyCompany("Repodeck")]',
    '[assembly: AssemblyCopyright("MIT License")]',
    "[assembly: AssemblyVersion(`"$version.0`")]",
    "[assembly: AssemblyFileVersion(`"$version.0`")]",
    "[assembly: AssemblyInformationalVersion(`"$version`")]")
}
$appInfo = Join-Path $dist 'AppInfo.cs'
$setupInfo = Join-Path $dist 'SetupInfo.cs'
New-AssemblyInfo $appInfo 'Repodeck'
New-AssemblyInfo $setupInfo 'Repodeck Setup'

# 1. launcher
if ($SignedApp) {
  Write-Host "Using the signed app $SignedApp"
  Copy-Item $SignedApp (Join-Path $stage 'Repodeck.exe')
} else {
  & $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$icon" "/win32manifest:$manifest" "/out:$stage\Repodeck.exe" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll "/r:$wv\Microsoft.Web.WebView2.Core.dll" "/r:$wv\Microsoft.Web.WebView2.WinForms.dll" `
    (Join-Path $root 'installer\src\Launcher.cs') (Join-Path $root 'installer\src\Window.cs') $appInfo
  if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }
}
Copy-Item -Recurse (Join-Path $wv '*') $stage

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
$setup = Join-Path $dist "RepodeckSetup-$version.exe"
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$icon" "/win32manifest:$manifest" "/resource:$zip,payload.zip" "/resource:$(Join-Path $root 'ui\icon-256.png'),logo.png" "/out:$setup" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  (Join-Path $root 'installer\src\Setup.cs') $buildInfo $setupInfo
if ($LASTEXITCODE -ne 0) { throw 'Setup build failed.' }

# dist\ is also a runnable copy of the launcher and window, used when running from source
Copy-Item (Join-Path $stage 'Repodeck.exe') $dist
Copy-Item -Recurse (Join-Path $wv '*') $dist
Remove-Item -Recurse -Force $stage, $zip, $buildInfo, $appInfo, $setupInfo
Get-ChildItem $dist | ForEach-Object { '{0,-36} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB) }
