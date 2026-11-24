# Builds the Windows app (EXE) with the embedded web UI.
# Run:  powershell -ExecutionPolicy Bypass -File tools\build_desktop.ps1
$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'desktop'
$web     = Join-Path $desktop 'web'
$zip     = Join-Path $desktop 'web.zip'
$publish = Join-Path $desktop 'publish'
$dist    = Join-Path (Split-Path -Parent $root) 'dist\ChessReview-win64'

Write-Host "==> copying web UI" -ForegroundColor Cyan
if (Test-Path $web) { Remove-Item $web -Recurse -Force }
New-Item -ItemType Directory -Path $web | Out-Null
foreach ($item in @('index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'vendor', 'engine', 'data', 'assets')) {
    Copy-Item (Join-Path $root $item) (Join-Path $web $item) -Recurse
}

Write-Host "==> packing web.zip" -ForegroundColor Cyan
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $web '*') -DestinationPath $zip -CompressionLevel Optimal

Write-Host "==> publishing EXE (self-contained, single file)" -ForegroundColor Cyan
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
dotnet publish (Join-Path $desktop 'ChessReview.csproj') -c Release -o $publish --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

Write-Host "==> collecting dist" -ForegroundColor Cyan
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Copy-Item (Join-Path $publish 'ChessReview.exe') (Join-Path $dist 'ChessReview.exe')

$exe = Join-Path $dist 'ChessReview.exe'
$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ("Done: {0} ({1} MB)" -f $exe, $mb) -ForegroundColor Green
