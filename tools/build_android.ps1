# Builds the Android APK (no Gradle required).
# Run:  powershell -ExecutionPolicy Bypass -File tools\build_android.ps1
#
# Requires JDK 17 + Android SDK (build-tools 34.0.0, platform android-34).
# Expected layout:
#   <repo>\buildtools\jdk\<jdk-dir>
#   <repo>\buildtools\android-sdk\{build-tools,platforms,cmdline-tools}
$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$android = Join-Path $root 'android'
$dist    = Join-Path (Split-Path -Parent $root) 'dist'
$bt      = Join-Path (Split-Path -Parent $root) 'buildtools'

$jdk = Get-ChildItem (Join-Path $bt 'jdk') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $jdk) { throw "JDK not found in $bt\jdk" }
$env:JAVA_HOME = $jdk.FullName
$env:PATH = (Join-Path $jdk.FullName 'bin') + ';' + $env:PATH

$sdk       = Join-Path $bt 'android-sdk'
$buildTools = Join-Path $sdk 'build-tools\34.0.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
$aapt2      = Join-Path $buildTools 'aapt2.exe'
$d8         = Join-Path $buildTools 'd8.bat'
$zipalign   = Join-Path $buildTools 'zipalign.exe'
$apksigner  = Join-Path $buildTools 'apksigner.bat'
$keytool    = Join-Path $jdk.FullName 'bin\keytool.exe'

foreach ($tool in @($aapt2, $d8, $zipalign, $apksigner, $androidJar)) {
    if (-not (Test-Path $tool)) { throw "Missing Android tool: $tool" }
}

$work   = Join-Path $android 'build'
$gen    = Join-Path $work 'gen'
$classes = Join-Path $work 'classes'
$dex    = Join-Path $work 'dex'
$resZip = Join-Path $work 'res.zip'
$baseApk = Join-Path $work 'base.apk'
$unsigned = Join-Path $work 'unsigned.apk'
$aligned = Join-Path $work 'aligned.apk'
$assets = Join-Path $android 'assets'
$keystore = Join-Path $bt 'debug.keystore'

Write-Host "==> copying web bundle into assets" -ForegroundColor Cyan
if (Test-Path $assets) { Remove-Item $assets -Recurse -Force }
New-Item -ItemType Directory -Path $assets | Out-Null
foreach ($item in @('index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'vendor', 'engine', 'data', 'assets')) {
    Copy-Item (Join-Path $root $item) (Join-Path $assets $item) -Recurse
}

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $gen, $classes, $dex -Force | Out-Null

Write-Host "==> aapt2 compile" -ForegroundColor Cyan
& $aapt2 compile --dir (Join-Path $android 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "==> aapt2 link" -ForegroundColor Cyan
& $aapt2 link -o $baseApk `
    -I $androidJar `
    --manifest (Join-Path $android 'AndroidManifest.xml') `
    -A $assets `
    --java $gen `
    --min-sdk-version 24 --target-sdk-version 34 `
    --auto-add-overlay `
    $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "==> javac" -ForegroundColor Cyan
$javaFiles = @()
$javaFiles += Get-ChildItem (Join-Path $android 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$javaFiles += Get-ChildItem $gen -Recurse -Filter *.java | ForEach-Object { $_.FullName }
# javac пишет заметки в stderr, а при ErrorActionPreference=Stop это ломает скрипт
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& (Join-Path $jdk.FullName 'bin\javac.exe') -encoding UTF-8 -source 8 -target 8 -nowarn -Xlint:-options `
    -bootclasspath $androidJar -classpath $androidJar -d $classes @javaFiles 2>&1 | ForEach-Object { Write-Host $_ }
$javacExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($javacExit -ne 0) { throw "javac failed" }

Write-Host "==> d8" -ForegroundColor Cyan
$classFiles = @(Get-ChildItem $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& $d8 --release --min-api 24 --lib $androidJar --output $dex @classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "==> packing classes.dex" -ForegroundColor Cyan
$py = @'
import sys, zipfile, os, shutil
src, dex, dst = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("classes.dex added")
'@
$pyPath = Join-Path $work 'pack.py'
Set-Content -Path $pyPath -Value $py -Encoding ASCII
& python $pyPath $baseApk (Join-Path $dex 'classes.dex') $unsigned
if ($LASTEXITCODE -ne 0) { throw "packing classes.dex failed" }

Write-Host "==> zipalign" -ForegroundColor Cyan
if (Test-Path $aligned) { Remove-Item $aligned -Force }
& $zipalign -f -p 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

if (-not (Test-Path $keystore)) {
    Write-Host "==> creating debug keystore" -ForegroundColor Cyan
    & $keytool -genkeypair -keystore $keystore -storepass android -keypass android `
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=Android Debug,O=Android,C=US" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}

Write-Host "==> signing" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$final = Join-Path $dist 'ChessReview-android.apk'
if (Test-Path $final) { Remove-Item $final -Force }
& $apksigner sign --ks $keystore --ks-pass pass:android --key-pass pass:android `
    --ks-key-alias androiddebugkey --out $final $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

& $apksigner verify --print-certs $final
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

$mb = [math]::Round((Get-Item $final).Length / 1MB, 2)
Write-Host ("Done: {0} ({1} MB)" -f $final, $mb) -ForegroundColor Green
