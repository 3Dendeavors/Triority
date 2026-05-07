param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = 'Stop'

$androidDir = Join-Path $RepoRoot 'android'
$appDir = Join-Path $androidDir 'app'
$propsPath = Join-Path $androidDir 'keystore.properties'
$googleServicesPath = Join-Path $appDir 'google-services.json'
$outDir = Join-Path $RepoRoot '_exports\github-release-secrets'

if (-not (Test-Path -LiteralPath $propsPath)) {
  throw "Missing keystore.properties at $propsPath"
}
if (-not (Test-Path -LiteralPath $googleServicesPath)) {
  throw "Missing google-services.json at $googleServicesPath"
}

$props = @{}
Get-Content -LiteralPath $propsPath | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    $props[$matches[1].Trim()] = $matches[2].Trim()
  }
}

$storeFile = $props['TRIORITY_RELEASE_STORE_FILE']
if (-not $storeFile) {
  throw 'TRIORITY_RELEASE_STORE_FILE is missing from keystore.properties'
}

$keystorePath = Join-Path $appDir $storeFile
if (-not (Test-Path -LiteralPath $keystorePath)) {
  throw "Missing release keystore at $keystorePath"
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

[Convert]::ToBase64String([IO.File]::ReadAllBytes($googleServicesPath)) |
  Set-Content -LiteralPath (Join-Path $outDir 'GOOGLE_SERVICES_JSON_BASE64.txt') -NoNewline

[Convert]::ToBase64String([IO.File]::ReadAllBytes($keystorePath)) |
  Set-Content -LiteralPath (Join-Path $outDir 'TRIORITY_RELEASE_KEYSTORE_BASE64.txt') -NoNewline

$props['TRIORITY_RELEASE_STORE_PASSWORD'] |
  Set-Content -LiteralPath (Join-Path $outDir 'TRIORITY_RELEASE_STORE_PASSWORD.txt') -NoNewline

$props['TRIORITY_RELEASE_KEY_ALIAS'] |
  Set-Content -LiteralPath (Join-Path $outDir 'TRIORITY_RELEASE_KEY_ALIAS.txt') -NoNewline

$props['TRIORITY_RELEASE_KEY_PASSWORD'] |
  Set-Content -LiteralPath (Join-Path $outDir 'TRIORITY_RELEASE_KEY_PASSWORD.txt') -NoNewline

Write-Host "Secret payload files written to $outDir"
Write-Host ''
Write-Host 'If GitHub CLI is installed and authenticated, run:'
Write-Host "gh secret set GOOGLE_SERVICES_JSON_BASE64 --repo 3Dendeavors/Triority < `"$outDir\GOOGLE_SERVICES_JSON_BASE64.txt`""
Write-Host "gh secret set TRIORITY_RELEASE_KEYSTORE_BASE64 --repo 3Dendeavors/Triority < `"$outDir\TRIORITY_RELEASE_KEYSTORE_BASE64.txt`""
Write-Host "gh secret set TRIORITY_RELEASE_STORE_PASSWORD --repo 3Dendeavors/Triority < `"$outDir\TRIORITY_RELEASE_STORE_PASSWORD.txt`""
Write-Host "gh secret set TRIORITY_RELEASE_KEY_ALIAS --repo 3Dendeavors/Triority < `"$outDir\TRIORITY_RELEASE_KEY_ALIAS.txt`""
Write-Host "gh secret set TRIORITY_RELEASE_KEY_PASSWORD --repo 3Dendeavors/Triority < `"$outDir\TRIORITY_RELEASE_KEY_PASSWORD.txt`""
