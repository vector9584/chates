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

function Stop-HermesProcess {
  # hermes.exe 正在跑时 kernel 目录和 venv 的 Scripts 都删不动（os error 32）
  foreach($n in @("hermes","node","python","hermes-gateway")){
    Get-Process -Name $n -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { try { $_.Kill(); } catch {} }
  }
  & schtasks /End /TN "HermesCustomPanel" 2>&1 | Out-Null
  Start-Sleep -Seconds 2
}

function Remove-PathForce {
  param([string]$Path)
  if(-not (Test-Path $Path)){ return }
  for($i=1; $i -le 3; $i++){
    try { Remove-Item $Path -Recurse -Force -ErrorAction Stop; return }
    catch { if($i -eq 3){ Warn ("cannot remove " + $Path + " : " + $_.Exception.Message) } else { Start-Sleep -Seconds 2 } }
  }
}

function Expand-Kernel {
  param([string]$ZipPath)
  $tmp = Join-Path $env:TEMP ("hk" + [Guid]::NewGuid().ToString("N"))
  Expand-Archive $ZipPath -DestinationPath $tmp -Force
  $inner = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  Remove-PathForce $Kernel
  New-Item -ItemType Directory -Force -Path $Kernel | Out-Null
  Copy-Item (Join-Path $inner "*") $Kernel -Recurse -Force
  Remove-Item $tmp -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $Root,$App,$Var | Out-Null
Say ("root = " + $Root)
Stop-HermesProcess

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
  Copy-Item (Join-Path $Kernel ("app\" + $d)) $dst -Recurse -Force
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

# 面板 bat 有两件事：确保后台在跑（已在跑就不管），然后开浏览器。
# 后台由计划任务 HermesCustomPanel 常驻，用户点快捷方式只该看见浏览器。
$lines = @("@echo off","chcp 65001 >nul",
 "set APP_DIR=$App","set DATA_DIR=$Data","set VAR_DIR=$Var",
 "set HERMES_HOME=$Data","set HERMES_VAR_DIR=$Var","set MONITOR_SOCKET_PATH=",
 "set UI_PORT=8650","set PORT=8650","set GATEWAY_PORT=8742","set DASHBOARD_PORT=9219",
 "set UI_HOST=127.0.0.1",
 "set PATH=$Venv\Scripts;$([System.IO.Path]::GetDirectoryName($node));%PATH%",
 "curl -s -o nul -m 2 http://127.0.0.1:8650/api/health >nul 2>&1",
 "if errorlevel 1 schtasks /Run /TN `"HermesCustomPanel`" >nul 2>&1",
 "for /l %%i in (1,1,30) do (",
 "  curl -s -o nul -m 2 http://127.0.0.1:8650/api/health >nul 2>&1 && goto :ready",
 "  timeout /t 1 /nobreak >nul",
 ")",
 ":ready",
 "start `"`" http://127.0.0.1:8650/")
Set-Content -Path $panelBat -Value ($lines -join "`r`n") -Encoding Default

$h = @("@echo off","chcp 65001 >nul","set HERMES_HOME=$Data","set APP_DIR=$App","set HERMES_VAR_DIR=$Var",
 "set PATH=$Venv\Scripts;%PATH%","cd /d $Kernel","`"$Hermes`" chat %*")
Set-Content -Path $hermesBat -Value ($h -join "`r`n") -Encoding Default

$u = @("@echo off","chcp 65001 >nul","cd /d `"$Here`"","powershell -NoProfile -ExecutionPolicy Bypass -File `"$Here\update.ps1`"","pause")
Set-Content -Path $updateBat -Value ($u -join "`r`n") -Encoding Default
# 后台静默启动器：WScript.Shell.Run 第二参数 0 = 隐藏窗口，第三参数 False = 不等待。
# 注意不要在双引号里写 "$env:XXX=" 当字面量 —— PowerShell 会先把它展开成空字符串，
# 生成的 vbs 就变成 `="C:\..."` 这种残句（实测直接跑不起）。用单引号拼。
$vbsPath = Join-Path $Root "后台启动.vbs"
$nodeDir = [System.IO.Path]::GetDirectoryName($node)
$vbs = @(
 ('Set sh = CreateObject("WScript.Shell")'),
 ('sh.Environment("PROCESS")("APP_DIR") = "' + $App + '"'),
 ('sh.Environment("PROCESS")("DATA_DIR") = "' + $Data + '"'),
 ('sh.Environment("PROCESS")("VAR_DIR") = "' + $Var + '"'),
 ('sh.Environment("PROCESS")("HERMES_HOME") = "' + $Data + '"'),
 ('sh.Environment("PROCESS")("HERMES_VAR_DIR") = "' + $Var + '"'),
 ('sh.Environment("PROCESS")("MONITOR_SOCKET_PATH") = ""'),
 ('sh.Environment("PROCESS")("UI_PORT") = "8650"'),
 ('sh.Environment("PROCESS")("UI_HOST") = "127.0.0.1"'),
 ('sh.Environment("PROCESS")("GATEWAY_PORT") = "8742"'),
 ('sh.Environment("PROCESS")("DASHBOARD_PORT") = "9219"'),
 ('sh.Environment("PROCESS")("PATH") = "' + $Venv + '\Scripts;' + $nodeDir + ';" & sh.Environment("PROCESS")("PATH")'),
 ('sh.CurrentDirectory = "' + $Kernel + '"'),
 ('sh.Run """' + $node + '"" ""' + $App + '\server\monitor.js""", 0, False')
)
Set-Content -Path $vbsPath -Value ($vbs -join "`r`n") -Encoding Default
Say "launchers written"

try {
  $ws = New-Object -ComObject WScript.Shell
  $desk = [Environment]::GetFolderPath("Desktop")
  # 只放一个桌面入口：用户要的是「点开就是操作界面」，后台进程由计划任务在登录时静默拉起，
  # 不该让他看见命令行窗口。命令行仍可通过 启动Hermes.bat 手动用，但不占桌面。
  # 清掉历史版本留下的多余入口（"Hermes 终端"），现在只要一个面板图标。
  foreach($stale in @("Hermes 终端.lnk","Hermes Terminal.lnk","启动Hermes.lnk")){
    $sp = Join-Path $desk $stale
    if(Test-Path $sp){ Remove-Item $sp -Force -ErrorAction SilentlyContinue }
  }
  foreach($pair in @(@($panelBat,"Hermes 面板"))){
    $lnk = $ws.CreateShortcut((Join-Path $desk ($pair[1] + ".lnk")))
    $lnk.TargetPath = $pair[0]
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
    $lnk.Save()
  }
  Say "desktop shortcuts created"
} catch { Warn ("shortcut failed: " + $_.Exception.Message) }

try {
  # 直接跑 node，不经过 bat：cmd 窗口不会闪出来。node.exe 是无控制台窗口的子系统程序。
  # 计划任务直接跑 vbs：vbs 用 WScript.Shell.Run(...,0,False) 起 node，
  # 0 表示隐藏窗口、False 表示不等 —— 用户看不到任何控制台闪一下。
  # 不把一长串 set 塞进 schtasks /TR：引号嵌套会碎，实测起不来。
  schtasks /Create /TN "HermesCustomPanel" /SC ONLOGON /RL LIMITED /TR "wscript.exe `"$Root\后台启动.vbs`"" /F 2>&1 | Out-Null
  Say "autostart registered"
} catch { Warn ("autostart failed: " + $_.Exception.Message) }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*HermesWin*monitor.js*" } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 1
& schtasks /Run /TN "HermesCustomPanel" 2>&1 | Out-Null
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
