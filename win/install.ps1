param([switch]$Force,[switch]$Silent)
# Hermes Windows Installer - installs YOUR fork (not upstream) with panel + data
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root     = Join-Path $env:LOCALAPPDATA "HermesWin"
$App      = Join-Path $Root "app"
$Kernel   = Join-Path $App "hermes-src"
$Data     = Join-Path $App "home\data"
$Var      = Join-Path $App "var"
$Venv     = Join-Path $Data "venv"
$Py       = Join-Path $Venv "Scripts\python.exe"
$Hermes   = Join-Path $Venv "Scripts\hermes.exe"
$RepoUrl  = "https://github.com/vector9584/hermes-agent-custom.git"
$Here     = $PSScriptRoot

function Say($m){ Write-Host ("[Hermes] " + $m) -ForegroundColor Cyan }
function Warn($m){ Write-Host ("[warn] " + $m) -ForegroundColor Yellow }
function Die($m){
  Write-Host ("[ERROR] " + $m) -ForegroundColor Red
  if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
  exit 1
}

New-Item -ItemType Directory -Force -Path $Root,$App,$Var | Out-Null
Say ("root = " + $Root)

# ---------- 1. uv ----------
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
  $zip = Join-Path $env:TEMP "uv-win.zip"
  try { Invoke-WebRequest "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" -OutFile $zip -UseBasicParsing }
  catch { Die ("uv download failed: " + $_.Exception.Message) }
  Expand-Archive $zip -DestinationPath $tools -Force
  $uv = (Get-ChildItem $tools -Recurse -Filter uv.exe | Select-Object -First 1).FullName
}
Say ("uv = " + $uv)

# ---------- 2. python ----------
Say "preparing Python 3.12 ..."
& $uv python install 3.12 2>&1 | ForEach-Object { Write-Host $_ }

# ---------- 3. kernel ----------
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if(-not $git){ $g = Join-Path $env:LOCALAPPDATA "hermes\git\cmd\git.exe"; if(Test-Path $g){ $git = $g } }

if(Test-Path (Join-Path $Kernel ".git")){
  Say "kernel present, updating ..."
  if($git){
    & $git -C $Kernel fetch --all --prune 2>&1 | ForEach-Object { Write-Host $_ }
    & $git -C $Kernel reset --hard origin/main 2>&1 | ForEach-Object { Write-Host $_ }
  }
} else {
  if(Test-Path $Kernel){ Remove-Item $Kernel -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Kernel | Out-Null
  if($git){
    Say "cloning kernel ..."
    & $git clone $RepoUrl $Kernel 2>&1 | ForEach-Object { Write-Host $_ }
  }
  if(-not (Test-Path (Join-Path $Kernel "pyproject.toml"))){
    Say "git clone unavailable, downloading zip ..."
    $z = Join-Path $env:TEMP "kernel.zip"
    try { Invoke-WebRequest "https://codeload.github.com/vector9584/hermes-agent-custom/zip/refs/heads/main" -OutFile $z -UseBasicParsing }
    catch { Die ("kernel download failed: " + $_.Exception.Message) }
    $tmp = Join-Path $env:TEMP ("k" + [Guid]::NewGuid().ToString("N"))
    Expand-Archive $z -DestinationPath $tmp -Force
    $inner = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    Copy-Item (Join-Path $inner "*") $Kernel -Recurse -Force
    Remove-Item $tmp -Recurse -Force
  }
}
if(-not (Test-Path (Join-Path $Kernel "pyproject.toml"))){ Die ("kernel incomplete: " + $Kernel) }
Say "kernel ok"

# ---------- 4. venv + deps ----------
if(-not (Test-Path $Py)){
  Say "creating venv ..."
  & $uv venv $Venv --python 3.12 2>&1 | ForEach-Object { Write-Host $_ }
}
Say "installing kernel deps (first run takes a few minutes) ..."
& $uv pip install --python $Py -e $Kernel 2>&1 | ForEach-Object { Write-Host $_ }
if($LASTEXITCODE -ne 0){ Die "dependency install failed, see log above" }

# 让顶层模块 (panel_config_bridge / _win_fcntl) 在任意 python 进程里可导入
$sitePkgs = Join-Path $Venv "Lib\site-packages"
if(Test-Path $sitePkgs){
  Set-Content -Path (Join-Path $sitePkgs "hermes_root.pth") -Value $Kernel -Encoding ascii -NoNewline
}

# ---------- 5. panel ----------
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
  try { Invoke-WebRequest "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip" -OutFile $nz -UseBasicParsing }
  catch { Die ("node download failed: " + $_.Exception.Message) }
  Expand-Archive $nz -DestinationPath (Join-Path $Root "tools") -Force
  $node = (Get-ChildItem (Join-Path $Root "tools") -Recurse -Filter node.exe | Select-Object -First 1).FullName
}
Set-Content -Path (Join-Path $Root "node.path") -Value $node -Encoding ascii
Say ("node = " + $node)

# ---------- 6. data ----------
$dz = Join-Path $Here "data.zip"
if(Test-Path $dz){
  $hasCfg = Test-Path (Join-Path $Data "config.yaml")
  if((-not $hasCfg) -or $Force){
    Say "unpacking data (config / .env / skills / knowledge) ..."
    if($hasCfg){
      $bk = Join-Path $Root ("data.bak." + (Get-Date -Format "yyyyMMddHHmmss"))
      Move-Item $Data $bk
      New-Item -ItemType Directory -Force -Path $Data | Out-Null
      Copy-Item (Join-Path $bk "venv") (Join-Path $Data "venv") -Recurse -Force
    }
    Expand-Archive $dz -DestinationPath $Data -Force
    Say "data ready"
  } else {
    Say "data already present, skipping (use -Force to overwrite)"
  }
} else {
  Warn "data.zip not found next to installer - skipping data"
}

# ---------- 7. launchers ----------
$panelBat = Join-Path $Root "启动面板.bat"
$hermesBat = Join-Path $Root "启动Hermes.bat"
$updateBat = Join-Path $Root "检查更新.bat"

$lines = @()
$lines += "@echo off"
$lines += "chcp 65001 >nul"
$lines += "set APP_DIR=$App"
$lines += "set DATA_DIR=$Data"
$lines += "set VAR_DIR=$Var"
$lines += "set HERMES_HOME=$Data"
$lines += "set HERMES_VAR_DIR=$Var"
$lines += "set MONITOR_SOCKET_PATH="
$lines += "set UI_PORT=8650"
$lines += "set PORT=8650"
$lines += "set GATEWAY_PORT=8742"
$lines += "set DASHBOARD_PORT=9219"
$lines += "set PATH=$Venv\Scripts;$([System.IO.Path]::GetDirectoryName($node));%PATH%"
$lines += "cd /d $Kernel"
$lines += "`"$node`" `"$App\server\monitor.js`""
Set-Content -Path $panelBat -Value ($lines -join "`r`n") -Encoding Default

$h = @()
$h += "@echo off"
$h += "chcp 65001 >nul"
$h += "set HERMES_HOME=$Data"
$h += "set APP_DIR=$App"
$h += "set HERMES_VAR_DIR=$Var"
$h += "set PATH=$Venv\Scripts;%PATH%"
$h += "cd /d $Kernel"
$h += "`"$Hermes`" chat %*"
Set-Content -Path $hermesBat -Value ($h -join "`r`n") -Encoding Default

$u = @()
$u += "@echo off"
$u += "chcp 65001 >nul"
$u += "powershell -NoProfile -ExecutionPolicy Bypass -File `"$Here\update.ps1`""
$u += "pause"
Set-Content -Path $updateBat -Value ($u -join "`r`n") -Encoding Default

Say "launchers written"

# ---------- 8. shortcut + autostart ----------
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
  Say "autostart task registered (HermesCustomPanel, on logon)"
} catch { Warn ("autostart task failed: " + $_.Exception.Message) }

# ---------- 9. start now ----------
try {
  $running = Get-Process node -ErrorAction SilentlyContinue
  Start-Process -FilePath $panelBat -WindowStyle Hidden
  Start-Sleep -Seconds 6
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8650/" -UseBasicParsing -TimeoutSec 10
  Say ("panel started: HTTP " + $r.StatusCode)
} catch { Warn ("panel start check: " + $_.Exception.Message) }

Say "---------------------------------------------"
Say ("installed at : " + $Root)
Say ("launch panel : " + $panelBat)
Say ("launch hermes: " + $hermesBat)
Say ("open http://127.0.0.1:8650/ in your browser")
Say "---------------------------------------------"
if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
