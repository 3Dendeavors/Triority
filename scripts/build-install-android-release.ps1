param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [switch]$Install,
  [string]$AdbPath = 'C:\Users\Ross\AppData\Local\Android\Sdk\platform-tools\adb.exe'
)

$ErrorActionPreference = 'Stop'

$androidDir = Join-Path $RepoRoot 'android'
$gradleHome = Join-Path $RepoRoot '.gradle-home-build'
$apkPath = Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'

if (-not (Test-Path -LiteralPath (Join-Path $androidDir 'keystore.properties'))) {
  throw 'Missing android\keystore.properties. Release signing cannot proceed.'
}
if (-not (Test-Path -LiteralPath (Join-Path $androidDir 'app\google-services.json'))) {
  throw 'Missing android\app\google-services.json. Firebase config is required for release builds.'
}

New-Item -ItemType Directory -Force -Path $gradleHome | Out-Null
$env:GRADLE_USER_HOME = $gradleHome

Push-Location $androidDir
try {
  & .\gradlew.bat :app:createBundleReleaseJsAndAssets --rerun-tasks :app:assembleRelease --no-daemon
  if ($LASTEXITCODE -ne 0) {
    throw "Gradle release build failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $apkPath)) {
  throw "Release APK was not created at $apkPath"
}

$hash = (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToUpperInvariant()
Write-Host "Built release APK: $apkPath"
Write-Host "SHA-256: $hash"

if ($Install) {
  if (-not (Test-Path -LiteralPath $AdbPath)) {
    throw "ADB not found at $AdbPath"
  }
  Write-Host 'Installing over existing app with adb install -r. This does not uninstall or wipe app data.'
  & $AdbPath install -r $apkPath
  if ($LASTEXITCODE -ne 0) {
    throw "ADB install failed with exit code $LASTEXITCODE."
  }
  & $AdbPath shell dumpsys package com.triority |
    Select-String -Pattern 'versionCode|versionName|firstInstallTime|lastUpdateTime'
}
