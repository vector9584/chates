param([switch]$Silent)
# Hermes updater: pull kernel + panel from GitHub, resync deps
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root   = Join-Path $env:LOCALAPPDATA "HermesWin"
$App    = Join-Path $Root "app"
$Kernel = Join-Path $App  "hermes-src"
$Data   = Join-Path $App  "home\data"
$Venv   = Join-Path $Data "venv"
$PyExe  = Join-Path $Venv "Scripts\python.exe"
$Hermes = Join-Path $Venv "Scripts\hermes.exe"
$Here   = $PSScriptRoot

function Say($m){ Write-Host ("[Update] " + $m) -ForegroundColor Cyan }

$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if(-not $uv){ $u = Join-Path $env:USERPROFILE ".local\bin\uv.exe"; if(Test-Path $u){ $uv = $u } }
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if(-not $git){ $g = Join-Path $env:LOCALAPPDATA "hermes\git\cmd\git.exe"; if(Test-Path $g){ $git = $g } }

if(-not (Test-Path (Join-Path $Kernel ".git"))){ Write-Host "kernel not installed, run install first" -ForegroundColor Red; if(-not $Silent){ Read-Host }; exit 1 }

Say "Fetching ..."
& $git -C $Kernel fetch --all --prune 2>&1 | ForEach-Object { Write-Host $_ }
$local  = (& $git -C $Kernel rev-parse HEAD).Trim()
$remote = (& $git -C $Kernel rev-parse origin/main).Trim()
Say ("local=" + $local.Substring(0,8) + "  remote=" + $remote.Substring(0,8))
if($local -eq $remote){
  Say "Already up to date."
} else {
  & $git -C $Kernel reset --hard origin/main 2>&1 | ForEach-Object { Write-Host $_ }
  Say "Kernel updated. Resyncing dependencies ..."
  & $uv pip install --python $PyExe -e $Kernel 2>&1 | ForEach-Object { Write-Host $_ }
  $panelSrc = Join-Path $Kernel "win\panel"
  if(Test-Path $panelSrc){
    foreach($d in @("server","ui")){
      $dst = Join-Path $App $d
      if(Test-Path $dst){ Remove-Item $dst -Recurse -Force }
      Copy-Item (Join-Path $panelSrc $d) $dst -Recurse -Force
    }
    Say "Panel updated."
  }
}

try { & $Hermes --version 2>&1 | ForEach-Object { Say $_ } } catch {}
Say "Done. Restart the panel to apply."
if(-not $Silent){ Read-Host "Press Enter to close" }
