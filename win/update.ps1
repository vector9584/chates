param([switch]$Silent)
$ErrorActionPreference = "Continue"
$Root  = Join-Path $env:LOCALAPPDATA "HermesWin"
$App   = Join-Path $Root "app"
$Kernel= Join-Path $App "hermes-src"
$Data  = Join-Path $App "home\data"
$Venv  = Join-Path $Data "venv"
$Py    = Join-Path $Venv "Scripts\python.exe"

function Say($m){ Write-Host ("[update] " + $m) -ForegroundColor Cyan }

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if(-not $git){ $g = Join-Path $env:LOCALAPPDATA "hermes\git\cmd\git.exe"; if(Test-Path $g){ $git = $g } }
if(-not (Test-Path (Join-Path $Kernel ".git"))){ Write-Host "kernel is not a git checkout, run install first" -ForegroundColor Red; exit 1 }

$before = (& $git -C $Kernel rev-parse HEAD).Trim()
Say ("current " + $before)
& $git -C $Kernel fetch --all --prune 2>&1 | ForEach-Object { Write-Host $_ }
$after = (& $git -C $Kernel rev-parse origin/main).Trim()
if($before -eq $after){
  Say "already up to date"
  if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
  exit 0
}
Say ("updating " + $before + " -> " + $after)

# 停面板
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*HermesWin*monitor.js*" } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 2

& $git -C $Kernel reset --hard origin/main 2>&1 | ForEach-Object { Write-Host $_ }
if($LASTEXITCODE -ne 0){ Write-Host "git reset failed" -ForegroundColor Red; exit 1 }

$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if(-not $uv){ $uv = Join-Path $env:USERPROFILE ".local\bin\uv.exe" }
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

Start-Process -FilePath (Join-Path $Root "启动面板.bat") -WindowStyle Hidden
Start-Sleep -Seconds 6
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8650/" -UseBasicParsing -TimeoutSec 10
  Say ("panel back up: HTTP " + $r.StatusCode)
} catch { Say ("panel check failed: " + $_.Exception.Message) }
Say ("done, now at " + $after)
if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
