# CHATES clean rebuild -- run on the target Windows box.
#
# Why not build on the NAS: electron-builder's NSIS target needs Windows (or wine),
# and this box cannot reach the NAS LAN -- only GitHub. So it pulls a stage zip
# from a public branch and assembles locally.
#
# Three steps: swap the shell code, swap in the clean data skeleton, repack.
# Real user data is RENAMED, never deleted -- if the skeleton is wrong we can go back.
#
# ASCII only on purpose: PowerShell 5.1 reads .ps1 as ANSI (codepage 936 here),
# so UTF-8 Chinese would be mangled or break parsing.
# NOT 'Stop': npm/electron-builder write warnings to stderr, and 2>&1 turns those
# into NativeCommandError records -- 'Stop' then aborts the whole build on a warning.
# Failures are caught by explicit $LASTEXITCODE checks instead.
$ErrorActionPreference = 'Continue'
$Root = Join-Path $env:USERPROFILE 'chates-electron'
$Here = $PSScriptRoot
$Res  = Join-Path $Root 'resources\chates'

function Say($m) { Write-Host "[stage] $m" }

if (-not (Test-Path (Join-Path $Root 'package.json'))) { throw "not a build dir: $Root" }

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

# 1. shell code
foreach ($f in @('main.js', 'package.json')) {
  $dst = Join-Path $Root $f
  if (Test-Path $dst) { Copy-Item $dst "$dst.bak-$ts" -Force }
  Copy-Item (Join-Path $Here "electron\$f") $dst -Force
  Say "shell: $f"
}

# 2. data skeleton (real data renamed aside, never deleted)
$Data = Join-Path $Res 'data'
$alreadyClean = $false
if (Test-Path $Data) {
  $cnt = (Get-ChildItem $Data -Recurse -File -ErrorAction SilentlyContinue).Count
  if (-not (Test-Path (Join-Path $Data '.env')) -and $cnt -le 20) { $alreadyClean = $true }
}
if ($alreadyClean) {
  Say "data dir already skeleton ($cnt files) -- skip swap"
} elseif (Test-Path $Data) {
  $hasReal = Test-Path (Join-Path $Data '.env')
  $bak = Join-Path $Res "data.real-$ts"
  Move-Item $Data $bak
  $note = if ($hasReal) { 'with real .env, kept' } else { 'no .env' }
  Say "old data renamed to $(Split-Path $bak -Leaf) ($note)"
}
New-Item -ItemType Directory -Path $Data -Force | Out-Null
Copy-Item (Join-Path $Here 'data-skeleton\*') $Data -Recurse -Force
$n = (Get-ChildItem $Data -Recurse -File).Count
Say "skeleton in place: $n files"
if (Test-Path (Join-Path $Data '.env')) { throw "skeleton contains .env -- abort" }

# 3. deps + package
Push-Location $Root
try {
  Say 'npm install (electron-updater)'
  & npm install --no-audit --no-fund 2>&1 | Select-Object -Last 4 | ForEach-Object { Say $_ }
  if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }

  Say 'electron-builder (-p never: no auto publish)'
  & npx electron-builder --win nsis --x64 -p never 2>&1 | Select-Object -Last 14 | ForEach-Object { Say $_ }
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed: $LASTEXITCODE" }
} finally { Pop-Location }

Say '=== dist ==='
Get-ChildItem (Join-Path $Root 'dist') -File |
  Where-Object { $_.Name -match 'Setup.*\.exe$|latest.*\.yml$|blockmap$' } |
  Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String | Write-Host
Say 'done'
