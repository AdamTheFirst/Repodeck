<#
  Builds the Microsoft Store package into dist\store\Repodeck-<version>.msix.

  The package holds the app, the interface, and its own copy of Node.js, so the only things a user
  still needs are Git and GitHub CLI. It is not signed here: the Store signs it after upload.

  Downloads (each checked against a pinned SHA-256):
    - Node.js for Windows x64, from nodejs.org (by build.ps1)
    - Microsoft's packaging tool (makeappx.exe), from the Microsoft.Windows.SDK.BuildTools package on nuget.org

    powershell -File scripts\build-store.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$vendor = Join-Path $root 'installer\vendor'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Pinned([string]$url, [string]$file, [string]$sha256) {
  if (-not (Test-Path $file)) {
    Write-Host "Downloading $url"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
    (New-Object Net.WebClient).DownloadFile($url, $file)
  }
  $got = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sha256) { Remove-Item $file; throw "$(Split-Path -Leaf $file) does not match its pinned hash (got $got)." }
}

# 1. the app itself (Repodeck.exe and the window's libraries)
$app = Join-Path $root 'local\store-app'
& (Join-Path $PSScriptRoot 'build.ps1') -Out $app | Out-Null
if (-not (Test-Path (Join-Path $app 'Repodeck.exe'))) { throw 'The app build failed.' }

# 3. makeappx.exe
$sdkVersion = '10.0.28000.2957'
$sdkHash = 'b7163fc6f636172726d0985963e4f7f11c41afe1c7fdfe78f8051877360ed696'
$sdkDir = Join-Path $vendor "sdk-buildtools-$sdkVersion"
$makeappx = Get-ChildItem $sdkDir -Recurse -Filter makeappx.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
if (-not $makeappx) {
  $pkg = Join-Path $vendor 'dl\sdk-buildtools.nupkg'
  Get-Pinned "https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/$sdkVersion/microsoft.windows.sdk.buildtools.$sdkVersion.nupkg" $pkg $sdkHash
  $x = Join-Path $vendor 'dl\sdk'
  if (Test-Path $x) { Remove-Item -Recurse -Force $x }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($pkg, $x)
  $src = Get-ChildItem $x -Recurse -Filter makeappx.exe | Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
  if (-not $src) { throw 'makeappx.exe was not found in the SDK package.' }
  New-Item -ItemType Directory -Force -Path (Join-Path $sdkDir 'x64') | Out-Null
  Copy-Item (Join-Path $src.DirectoryName '*') (Join-Path $sdkDir 'x64') -Recurse
  Remove-Item -Recurse -Force (Join-Path $vendor 'dl')
  $makeappx = Get-Item (Join-Path $sdkDir 'x64\makeappx.exe')
}

# 4. the package's folder
$out = Join-Path $root 'dist\store'
$layout = Join-Path $root 'local\store-layout'
foreach ($d in $out, $layout) { if (Test-Path $d) { Remove-Item -Recurse -Force $d }; New-Item -ItemType Directory -Force -Path $d | Out-Null }
Copy-Item (Join-Path $app 'Repodeck.exe'), (Join-Path $app '*.dll'), (Join-Path $app 'WebView2-LICENSE.txt') $layout
Copy-Item -Recurse (Join-Path $app 'runtimes') $layout
foreach ($d in 'server', 'ui') { Copy-Item -Recurse (Join-Path $root $d) (Join-Path $layout $d) }
foreach ($f in 'package.json', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'installer\repodeck.ico') { Copy-Item (Join-Path $root $f) $layout }
Copy-Item -Recurse (Join-Path $app 'node') $layout   # the pinned Node.js that build.ps1 fetched
& node (Join-Path $PSScriptRoot 'make-icon.js') --store (Join-Path $layout 'Assets') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The Store pictures could not be made.' }
Move-Item (Join-Path $layout 'Assets\StoreListingLogo300.png') (Join-Path $out 'StoreListingLogo300.png')   # for the Store listing, not the package
$manifest = (Get-Content (Join-Path $root 'installer\store\AppxManifest.xml') -Raw).Replace('{VERSION}', "$version.0")
Set-Content -Path (Join-Path $layout 'AppxManifest.xml') -Value $manifest -Encoding UTF8

# 5. pack
$msix = Join-Path $out "Repodeck-$version.msix"
& $makeappx.FullName pack /o /d $layout /p $msix | Select-Object -Last 3
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $msix)) { throw 'makeappx failed.' }
Remove-Item -Recurse -Force $layout, $app
Get-ChildItem $out | ForEach-Object { '{0,-36} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB) }
