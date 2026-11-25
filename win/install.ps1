﻿# =====================================================================
#  Hermes Windows Installer  (customized kernel of vector9584)
#  用法：双击 安装.bat  或  powershell -ExecutionPolicy Bypass -File install.ps1
#  可选：-Force   覆盖已有数据目录
# =====================================================================
param([switch]$Force,[switch]$Silent)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root   = Join-Path $env:LOCALAPPDATA "HermesWin"
$App    = Join-Path $Root "app"                 # APP_DIR
$Kernel = Join-Path $App  "hermes-src"          # 内核源码
$Data   = Join-Path $App  "home\data"           # DATA_DIR / HERMES_HOME
$Var    = Join-Path $App  "var"                 # VAR_DIR
$Venv   = Join-Path $Data "venv"
$PyExe  = Join-Path $Venv "Scripts\python.exe"
$Hermes = Join-Path $Venv "Scripts\hermes.exe"
$Repo   = "https://github.com/vector9584/hermes-agent-custom.git"
$Here   = $PSScriptRoot

function Say($m){ Write-Host ("[Hermes] " + $m) -ForegroundColor Cyan }
function Warn($m){ Write-Host ("[WARN] " + $m) -ForegroundColor Yellow }
function Die($m){ Write-Host ("[ERROR] " + $m) -ForegroundColor Red; if(-not $Silent){ Read-Host "Press Enter to exit" }; exit 1 }

Say ("Install root: " + $Root)
New-Item -ItemType Directory -Force -Path $Root,$App,$Data,$Var | Out-Null

# ---------- 1. uv ----------
$uv = $null
foreach($c in @( (Get-Command uv -ErrorAction SilentlyContinue).Source,
                 (Join-Path $env:USERPROFILE ".local\bin\uv.exe"),
                 (Join-Path $Root "tools\uv.exe") )){
  if($c -and (Test-Path $c)){ $uv = $c; break }
}
if(-not $uv){
  Say "uv not found, downloading ..."
  $tools = Join-Path $Root "tools"; New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $zip = Join-Path $env:TEMP "uv-win.zip"
  try { Invoke-WebRequest "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" -OutFile $zip -UseBasicParsing }
  catch { Die ("download uv failed: " + $_) }
  Expand-Archive $zip -DestinationPath $tools -Force
  $uv = (Get-ChildItem $tools -Recurse -Filter uv.exe | Select-Object -First 1).FullName
}
Say ("uv = " + $uv)

# ---------- 2. git ----------
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if(-not $git){ $g = Join-Path $env:LOCALAPPDATA "hermes\git\cmd\git.exe"; if(Test-Path $g){ $git = $g } }
if(-not $git){ $g = Join-Path $Root "tools\git\cmd\git.exe"; if(Test-Path $g){ $git = $g } }

# ---------- 3. Python 3.12 ----------
Say "Preparing Python 3.12 ..."
& $uv python install 3.12 2>&1 | ForEach-Object { Write-Host $_ }

# ---------- 4. kernel ----------
if(Test-Path (Join-Path $Kernel ".git")){
  Say "Kernel exists, pulling latest ..."
  if($git){ & $git -C $Kernel fetch --all --prune 2>&1 | ForEach-Object { Write-Host $_ }
            & $git -C $Kernel reset --hard origin/main 2>&1 | ForEach-Object { Write-Host $_ } }
} else {
  if(Test-Path $Kernel){ Remove-Item $Kernel -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Kernel | Out-Null
  if($git){
    Say "Cloning kernel (this may take a minute) ..."
    & $git clone --depth 1 $Repo $Kernel 2>&1 | ForEach-Object { Write-Host $_ }
  } else {
    Say "git not found, downloading source zip ..."
    $z = Join-Path $env:TEMP "kernel.zip"
    Invoke-WebRequest "https://codeload.github.com/vector9584/hermes-agent-custom/zip/refs/heads/main" -OutFile $z -UseBasicParsing
    $tmp = Join-Path $Root "tmpk"
    if(Test-Path $tmp){ Remove-Item $tmp -Recurse -Force }
    Expand-Archive $z -DestinationPath $tmp -Force
    $inner = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    Copy-Item (Join-Path $inner "*") $Kernel -Recurse -Force
    Remove-Item $tmp -Recurse -Force
  }
}
if(-not (Test-Path (Join-Path $Kernel "pyproject.toml"))){ Die ("kernel incomplete: " + $Kernel) }

# ---------- 5. venv + deps ----------
if(-not (Test-Path $PyExe)){
  Say "Creating virtualenv ..."
  & $uv venv $Venv --python 3.12 2>&1 | ForEach-Object { Write-Host $_ }
}
Say "Installing kernel dependencies (first run: 3-8 min) ..."
& $uv pip install --python $PyExe -e $Kernel 2>&1 | ForEach-Object { Write-Host $_ }
if($LASTEXITCODE -ne 0){ Die "dependency install failed" }
if(-not (Test-Path $Hermes)){ Warn "hermes.exe entry not found; check pip output" }

# ---------- 6. panel ----------
Say "Deploying panel ..."
$panelSrc = Join-Path $Kernel "win\panel"
if(Test-Path $panelSrc){
  foreach($d in @("server","ui")){
    $dst = Join-Path $App $d
    if(Test-Path $dst){ Remove-Item $dst -Recurse -Force }
    Copy-Item (Join-Path $panelSrc $d) $dst -Recurse -Force
  }
  Set-Content -Path (Join-Path $App "package.json") -Value '{"type":"module"}' -Encoding utf8
} else { Warn "win/panel not found in kernel; panel skipped" }

# ---------- 7. node ----------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if(-not $node){ $n = Join-Path $env:LOCALAPPDATA "hermes\node\node.exe"; if(Test-Path $n){ $node = $n } }
if(-not $node){
  $n = Join-Path $Root "tools\node\node.exe"
  if(-not (Test-Path $n)){
    Say "Downloading Node.js ..."
    try {
      $nz = Join-Path $env:TEMP "node.zip"
      Invoke-WebRequest "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip" -OutFile $nz -UseBasicParsing
      Expand-Archive $nz -DestinationPath (Join-Path $Root "tools\nodezip") -Force
      $found = (Get-ChildItem (Join-Path $Root "tools\nodezip") -Recurse -Filter node.exe | Select-Object -First 1).FullName
      Copy-Item $found $n -Force
    } catch { Warn ("node download failed: " + $_) }
  }
  if(Test-Path $n){ $node = $n }
}
Say ("node = " + $node)

# ---------- 8. data ----------
$dz = Join-Path $Here "data.zip"
$HasData = Test-Path (Join-Path $Data "config.yaml")
if((Test-Path $dz) -and ((-not $HasData) -or $Force)){
  Say "Unpacking data (config / skills / knowledge) ..."
  if($HasData){
    $bak = Join-Path $Root ("data.bak." + (Get-Date -Format "yyyyMMddHHmmss"))
    Move-Item $Data $bak
    New-Item -ItemType Directory -Force -Path $Data | Out-Null
    Say ("old data backed up to " + $bak)
  }
  Expand-Archive $dz -DestinationPath $Data -Force
} elseif($HasData){
  Say "data already present, skipped (use -Force to overwrite)"
} else {
  Warn "data.zip not found; starting with empty data"
}

# ---------- 9. launchers ----------
$envBlock = @"
set "APP_DIR=$App"
set "DATA_DIR=$Data"
set "VAR_DIR=$Var"
set "HERMES_HOME=$Data"
set "HERMES_VAR_DIR=$Var"
set "MONITOR_SOCKET_PATH="
set "UI_PORT=8650"
set "GATEWAY_PORT=8742"
set "DASHBOARD_PORT=9219"
set "PATH=$Venv\Scripts;$(if($node){Split-Path $node}else{''});%PATH%"
"@
Set-Content -Path (Join-Path $Root "env.bat") -Value $envBlock -Encoding Default

$nodeCmd = if($node){ "`"$node`"" } else { "node" }
$panelBat = @"
@echo off
chcp 65001 >nul
call "%~dp0env.bat"
cd /d "$App"
echo Hermes panel: http://127.0.0.1:8650
"$nodeCmd" "$App\server\monitor.js"
"@
Set-Content -Path (Join-Path $Root "启动面板.bat") -Value $panelBat -Encoding Default

$hermesBat = @"
@echo off
chcp 65001 >nul
call "%~dp0env.bat"
"$Hermes" %*
"@
Set-Content -Path (Join-Path $Root "启动Hermes.bat") -Value $hermesBat -Encoding Default

# 桌面快捷方式
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Hermes 面板.lnk"))
  $lnk.TargetPath = Join-Path $Root "启动面板.bat"
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
  $lnk.Save()
  Say "Desktop shortcut created"
} catch { Warn "shortcut failed" }

# ---------- 10. summary ----------
Say "================ INSTALL DONE ================"
Say ("Root    : " + $Root)
Say ("Kernel  : " + $Kernel)
Say ("Data    : " + $Data)
Say ("Panel   : 双击 '" + (Join-Path $Root '启动面板.bat') + "'  -> http://127.0.0.1:8650")
Say ("CLI     : 双击 '" + (Join-Path $Root '启动Hermes.bat') + "'")
try { & $Hermes --version 2>&1 | ForEach-Object { Say $_ } } catch {}
Say "Update  : 双击 '检查更新.bat'"
if(-not $Silent){ Read-Host "Press Enter to close" }
