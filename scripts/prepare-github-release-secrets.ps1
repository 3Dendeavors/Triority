param(
  [string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path,
  [string]$Repo = '3Dendeavors/Triority',
  [switch]$Upload
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

$secretFiles = [ordered]@{
  GOOGLE_SERVICES_JSON_BASE64 = Join-Path $outDir 'GOOGLE_SERVICES_JSON_BASE64.txt'
  TRIORITY_RELEASE_KEYSTORE_BASE64 = Join-Path $outDir 'TRIORITY_RELEASE_KEYSTORE_BASE64.txt'
  TRIORITY_RELEASE_STORE_PASSWORD = Join-Path $outDir 'TRIORITY_RELEASE_STORE_PASSWORD.txt'
  TRIORITY_RELEASE_KEY_ALIAS = Join-Path $outDir 'TRIORITY_RELEASE_KEY_ALIAS.txt'
  TRIORITY_RELEASE_KEY_PASSWORD = Join-Path $outDir 'TRIORITY_RELEASE_KEY_PASSWORD.txt'
}

if ($Upload) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    throw 'GitHub CLI is not installed or not on PATH.'
  }
  gh auth status | Out-Null
  foreach ($entry in $secretFiles.GetEnumerator()) {
    gh secret set $entry.Key --repo $Repo --body-file $entry.Value
  }
  Write-Host "GitHub Actions release secrets uploaded to $Repo"
  exit 0
}

Write-Host 'To upload these with GitHub CLI after authentication, run:'
Write-Host ".\scripts\prepare-github-release-secrets.ps1 -Upload"
Write-Host ''
Write-Host 'Manual fallback commands:'
foreach ($entry in $secretFiles.GetEnumerator()) {
  Write-Host "gh secret set $($entry.Key) --repo $Repo --body-file `"$($entry.Value)`""
}
