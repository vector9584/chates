param([switch]$Force,[switch]$Silent)
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

New-Item -ItemType Directory -Force -Path $Root,$App,$Var | Out-Null
Say ("root = " + $Root)

$uv = $null
$cand = @()
$cmd = Get-Command uv -ErrorAction SilentlyContinue
if($cmd){ $cand += $cmd.Source }
$cand += (Join-Path $env:USERPROFILE ".local\bin\uv.exe")
$cand += (Join-Path $Root "tools\uv.exe")
foreach($c in $cand){ if($c -and (Test-Path $c)){ $uv = $c; break } }
if(-not $uv){
  Say "uv not found, downloading ..."
  $tools = Join-Path $Root "tools"; New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $z = Join-Path $env:TEMP "uv-win.zip"
  try { Invoke-WebRequest "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" -OutFile $z -UseBasicParsing -TimeoutSec 120 }
  catch { Die ("uv download failed: " + $_.Exception.Message) }
  Expand-Archive $z -DestinationPath $tools -Force
  $uv = (Get-ChildItem $tools -Recurse -Filter uv.exe | Select-Object -First 1).FullName
}
Say ("uv = " + $uv)

Say "preparing Python 3.12 ..."
& $uv python install 3.12 2>&1 | ForEach-Object { Write-Host $_ }

$kz = Join-Path $env:TEMP "kernel-main.zip"
if(-not (Get-KernelZip -Dest $kz)){ Die "cannot download kernel from any mirror" }
Expand-Kernel -ZipPath $kz
if(-not (Test-Path (Join-Path $Kernel "pyproject.toml"))){ Die ("kernel incomplete: " + $Kernel) }
Say "kernel ready"
Copy-Item (Join-Path $Kernel "win\version.json") (Join-Path $App "version.json") -Force

if(-not (Test-Path $Py)){
  Say "creating venv ..."
  & $uv venv $Venv --python 3.12 2>&1 | ForEach-Object { Write-Host $_ }
}
Say "installing deps (first run takes a few minutes) ..."
& $uv pip install --python $Py -e $Kernel 2>&1 | ForEach-Object { Write-Host $_ }
if($LASTEXITCODE -ne 0){ Die "dependency install failed" }

$sitePkgs = Join-Path $Venv "Lib\site-packages"
if(Test-Path $sitePkgs){ Set-Content -Path (Join-Path $sitePkgs "hermes_root.pth") -Value $Kernel -Encoding ascii -NoNewline }

Say "deploying panel ..."
foreach($d in @("server","ui")){
  $dst = Join-Path $App $d
  if(Test-Path $dst){ Remove-Item $dst -Recurse -Force }
  Copy-Item (Join-Path $Kernel ("win\panel\" + $d)) $dst -Recurse -Force
}
Set-Content -Path (Join-Path $App "server\package.json") -Value '{"type":"module"}' -Encoding ascii

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if(-not $node){ $n = Join-Path $env:LOCALAPPDATA "hermes\node\node.exe"; if(Test-Path $n){ $node = $n } }
if(-not $node){ $n2 = Join-Path $Root "tools\node.exe"; if(Test-Path $n2){ $node = $n2 } }
if(-not $node){
  Say "downloading Node.js ..."
  $nz = Join-Path $env:TEMP "node.zip"
  try { Invoke-WebRequest "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip" -OutFile $nz -UseBasicParsing -TimeoutSec 180 }
  catch { Die ("node download failed: " + $_.Exception.Message) }
  Expand-Archive $nz -DestinationPath (Join-Path $Root "tools") -Force
  $node = (Get-ChildItem (Join-Path $Root "tools") -Recurse -Filter node.exe | Select-Object -First 1).FullName
}
Set-Content -Path (Join-Path $Root "node.path") -Value $node -Encoding ascii
Say ("node = " + $node)

$dz = Join-Path $Here "data.zip"
if(Test-Path $dz){
  $hasCfg = Test-Path (Join-Path $Data "config.yaml")
  if((-not $hasCfg) -or $Force){
    Say "unpacking data ..."
    if($hasCfg){
      $bk = Join-Path $Root ("data.bak." + (Get-Date -Format "yyyyMMddHHmmss"))
      Move-Item $Data $bk
      New-Item -ItemType Directory -Force -Path $Data | Out-Null
      if(Test-Path (Join-Path $bk "venv")){ Move-Item (Join-Path $bk "venv") (Join-Path $Data "venv") }
    }
    Expand-Archive $dz -DestinationPath $Data -Force
    $sitePkgs = Join-Path $Venv "Lib\site-packages"
    if(Test-Path $sitePkgs){ Set-Content -Path (Join-Path $sitePkgs "hermes_root.pth") -Value $Kernel -Encoding ascii -NoNewline }
    Say "data ready"
  } else { Say "data present, skip (use -Force to overwrite)" }
} else { Warn "data.zip not found next to installer" }

$panelBat = Join-Path $Root "启动面板.bat"
$hermesBat = Join-Path $Root "启动Hermes.bat"
$updateBat = Join-Path $Root "检查更新.bat"

$lines = @("@echo off","chcp 65001 >nul",
 "set APP_DIR=$App","set DATA_DIR=$Data","set VAR_DIR=$Var",
 "set HERMES_HOME=$Data","set HERMES_VAR_DIR=$Var","set MONITOR_SOCKET_PATH=",
 "set UI_PORT=8650","set PORT=8650","set GATEWAY_PORT=8742","set DASHBOARD_PORT=9219",
 "set PATH=$Venv\Scripts;$([System.IO.Path]::GetDirectoryName($node));%PATH%",
 "cd /d $Kernel","`"$node`" `"$App\server\monitor.js`"")
Set-Content -Path $panelBat -Value ($lines -join "`r`n") -Encoding Default

$h = @("@echo off","chcp 65001 >nul","set HERMES_HOME=$Data","set APP_DIR=$App","set HERMES_VAR_DIR=$Var",
 "set PATH=$Venv\Scripts;%PATH%","cd /d $Kernel","`"$Hermes`" chat %*")
Set-Content -Path $hermesBat -Value ($h -join "`r`n") -Encoding Default

$u = @("@echo off","chcp 65001 >nul","cd /d `"$Here`"","powershell -NoProfile -ExecutionPolicy Bypass -File `"$Here\update.ps1`"","pause")
Set-Content -Path $updateBat -Value ($u -join "`r`n") -Encoding Default
Say "launchers written"

try {
  $ws = New-Object -ComObject WScript.Shell
  $desk = [Environment]::GetFolderPath("Desktop")
  foreach($pair in @(@($panelBat,"Hermes 面板"), @($hermesBat,"Hermes 终端"))){
    $lnk = $ws.CreateShortcut((Join-Path $desk ($pair[1] + ".lnk")))
    $lnk.TargetPath = $pair[0]
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
    $lnk.Save()
  }
  Say "desktop shortcuts created"
} catch { Warn ("shortcut failed: " + $_.Exception.Message) }

try {
  schtasks /Create /TN "HermesCustomPanel" /SC ONLOGON /RL LIMITED /TR "`"$panelBat`"" /F 2>&1 | Out-Null
  Say "autostart registered"
} catch { Warn ("autostart failed: " + $_.Exception.Message) }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*HermesWin*monitor.js*" } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 1
Start-Process -FilePath $panelBat -WindowStyle Hidden
Start-Sleep -Seconds 8
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8650/" -UseBasicParsing -TimeoutSec 10
  Say ("panel started: HTTP " + $r.StatusCode)
} catch { Warn ("panel check: " + $_.Exception.Message) }

Say "---------------------------------------------"
Say ("installed : " + $Root)
Say ("panel     : " + $panelBat)
Say ("hermes    : " + $hermesBat)
Say "open http://127.0.0.1:8650/"
Say "---------------------------------------------"
if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
