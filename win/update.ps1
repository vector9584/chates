param([switch]$Silent)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Root   = Join-Path $env:LOCALAPPDATA "HermesWin"
$App    = Join-Path $Root "app"
$Kernel = Join-Path $App "hermes-src"
$Data   = Join-Path $App "home\data"
$Var    = Join-Path $App "var"
$Venv   = Join-Path $Data "venv"
$Py     = Join-Path $Venv "Scripts\python.exe"
$Hermes = Join-Path $Venv "Scripts\hermes.exe"
$Here   = $PSScriptRoot

$ZipUrls = @(
  "https://gh-proxy.com/https://github.com/vector9584/hermes-agent-custom/archive/refs/heads/main.zip",
  "https://ghfast.top/https://github.com/vector9584/hermes-agent-custom/archive/refs/heads/main.zip",
  "https://codeload.github.com/vector9584/hermes-agent-custom/zip/refs/heads/main"
)
function Say($m){ Write-Host ("[Hermes] " + $m) -ForegroundColor Cyan }
function Warn($m){ Write-Host ("[warn] " + $m) -ForegroundColor Yellow }
function Die($m){
  Write-Host ("[ERROR] " + $m) -ForegroundColor Red
  if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
  exit 1
}

function Get-KernelZip {
  param([string]$Dest)
  foreach($u in $ZipUrls){
    try {
      Say ("downloading kernel: " + $u)
      Invoke-WebRequest -Uri $u -OutFile $Dest -UseBasicParsing -TimeoutSec 180
      if((Get-Item $Dest).Length -gt 1000000){ return $true }
    } catch { Warn ("failed: " + $_.Exception.Message) }
  }
  return $false
}

function Expand-Kernel {
  param([string]$ZipPath)
  $tmp = Join-Path $env:TEMP ("hk" + [Guid]::NewGuid().ToString("N"))
  Expand-Archive $ZipPath -DestinationPath $tmp -Force
  $inner = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  if(Test-Path $Kernel){ Remove-Item $Kernel -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Kernel | Out-Null
  Copy-Item (Join-Path $inner "*") $Kernel -Recurse -Force
  Remove-Item $tmp -Recurse -Force
}

if(-not (Test-Path (Join-Path $Kernel "pyproject.toml"))){ Die "not installed yet, run install.bat first" }

$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if(-not $uv){ $uv = Join-Path $env:USERPROFILE ".local\bin\uv.exe" }

$kz = Join-Path $env:TEMP "kernel-update.zip"
if(-not (Get-KernelZip -Dest $kz)){ Die "cannot download update from any mirror" }

$tmp = Join-Path $env:TEMP ("hu" + [Guid]::NewGuid().ToString("N"))
Expand-Archive $kz -DestinationPath $tmp -Force
$inner = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
$newVer = "unknown"
$vf = Join-Path $inner "win\version.json"
if(Test-Path $vf){ $newVer = (Get-Content $vf -Raw | ConvertFrom-Json).version }
$oldVer = "none"
$of = Join-Path $App "version.json"
if(Test-Path $of){ try { $oldVer = (Get-Content $of -Raw | ConvertFrom-Json).version } catch {} }
Say ("local " + $oldVer + " -> remote " + $newVer)
if($oldVer -eq $newVer){
  Say "already up to date"
  Remove-Item $tmp -Recurse -Force
  if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
  exit 0
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*HermesWin*monitor.js*" } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 2

if(Test-Path $Kernel){ Remove-Item $Kernel -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Kernel | Out-Null
Copy-Item (Join-Path $inner "*") $Kernel -Recurse -Force
Remove-Item $tmp -Recurse -Force
Copy-Item (Join-Path $Kernel "win\version.json") (Join-Path $App "version.json") -Force
Say "kernel replaced"

Say "syncing deps ..."
& $uv pip install --python $Py -e $Kernel 2>&1 | ForEach-Object { Write-Host $_ }

foreach($d in @("server","ui")){
  $dst = Join-Path $App $d
  if(Test-Path $dst){ Remove-Item $dst -Recurse -Force }
  Copy-Item (Join-Path $Kernel ("win\panel\" + $d)) $dst -Recurse -Force
}
Set-Content -Path (Join-Path $App "server\package.json") -Value '{"type":"module"}' -Encoding ascii
$sitePkgs = Join-Path $Venv "Lib\site-packages"
if(Test-Path $sitePkgs){ Set-Content -Path (Join-Path $sitePkgs "hermes_root.pth") -Value $Kernel -Encoding ascii -NoNewline }

& schtasks /Run /TN "HermesCustomPanel" 2>&1 | Out-Null
Start-Sleep -Seconds 8
try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:8650/" -UseBasicParsing -TimeoutSec 10; Say ("panel back: HTTP " + $r.StatusCode) }
catch { Warn ("panel check: " + $_.Exception.Message) }
Say ("done, now " + $newVer)
if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
