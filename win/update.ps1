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

$Repo = "vector9584/chates"
# 直连优先（Windows 实测 0.75s），镜像兜底。ghfast 实测 403，不放。
$ApiUrls = @(
  "https://api.github.com/repos/$Repo/releases/latest",
  "https://gh-proxy.com/https://api.github.com/repos/$Repo/releases/latest"
)
$DlPrefixes = @("", "https://gh-proxy.com/")

function Say($m){ Write-Host ("[CHATES] " + $m) -ForegroundColor Cyan }
function Warn($m){ Write-Host ("[warn] " + $m) -ForegroundColor Yellow }
function Die($m){
  Write-Host ("[ERROR] " + $m) -ForegroundColor Red
  if(-not $Silent){ Read-Host "Press Enter to exit" | Out-Null }
  exit 1
}

# ---------------------------------------------------------------- 版本比对
function Get-CurrentVersion {
  # 唯一真源：安装器落盘的 $App\version.json（install.ps1:101 写的就是这个位置）
  foreach($f in @((Join-Path $App "version.json"), (Join-Path $Root "version.json"), (Join-Path $Kernel "win\version.json"))){
    if(Test-Path $f){
      try {
        $v = (Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json).version
        if($v){ return $v }
      } catch {}
    }
  }
  return "0.0.0"
}

function Compare-Ver($a, $b) {
  # 只比数字段，win.N 后缀单独比数字
  $pa = ($a -replace '[^0-9\.]','.').Split('.') | Where-Object { $_ -ne '' }
  $pb = ($b -replace '[^0-9\.]','.').Split('.') | Where-Object { $_ -ne '' }
  $n = [Math]::Max($pa.Count, $pb.Count)
  for($i=0; $i -lt $n; $i++){
    $x = 0; $y = 0
    if($i -lt $pa.Count){ [void][int]::TryParse($pa[$i], [ref]$x) }
    if($i -lt $pb.Count){ [void][int]::TryParse($pb[$i], [ref]$y) }
    if($x -lt $y){ return -1 }
    if($x -gt $y){ return 1 }
  }
  return 0
}

# ---------------------------------------------------------------- 取最新 Release
function Get-LatestRelease {
  foreach($u in $ApiUrls){
    try {
      Say ("checking: " + $u)
      $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 30
      $j = $r.Content | ConvertFrom-Json
      if($j.tag_name){
        return @{
          tag    = $j.tag_name
          name   = $j.name
          body   = $j.body
          assets = @($j.assets | ForEach-Object { @{ name = $_.name; url = $_.browser_download_url; size = $_.size } })
        }
      }
    } catch { Warn ("failed: " + $_.Exception.Message) }
  }
  return $null
}

function Download-Asset {
  param([string]$Url, [string]$Dest)
  foreach($p in $DlPrefixes){
    $u = $p + $Url
    try {
      Say ("downloading: " + $u)
      Invoke-WebRequest -Uri $u -OutFile $Dest -UseBasicParsing -TimeoutSec 600
      if((Get-Item $Dest).Length -gt 1000000){ return $true }
    } catch { Warn ("failed: " + $_.Exception.Message) }
  }
  return $false
}

# ---------------------------------------------------------------- 停服务
function Stop-HermesProcess {
  # 只杀 HermesWin 路径下的，别误伤系统其他 node / python
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe' OR Name='hermes.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like "*$Root*" -or $_.CommandLine -like "*$Root*" } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Say ("stopped pid " + $_.ProcessId) } catch {}
    }
  & schtasks /End /TN "HermesCustomPanel" 2>$null | Out-Null
  Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------- 主流程
Say ("current version: " + (Get-CurrentVersion))
$rel = Get-LatestRelease
if(-not $rel){ Die "cannot reach GitHub release API (network or rate limit)" }
Say ("latest release: " + $rel.tag + "  (" + $rel.name + ")")

$cur = Get-CurrentVersion
# release tag 形如 v0.20.0-win.6，取去掉 v 的部分对比
$latest = $rel.tag -replace '^v',''
if((Compare-Ver $cur $latest) -ge 0){
  Say "already up to date."
  if(-not $Silent){ Start-Sleep -Seconds 2 }
  exit 0
}

Say ("update available: " + $cur + " -> " + $latest)
if($rel.body){ Write-Host ""; Write-Host $rel.body; Write-Host "" }

$setup = $rel.assets | Where-Object { $_.name -like "HermesWin-Setup-*.zip" } | Select-Object -First 1
if(-not $setup){
  Warn "this release has no Windows setup asset. Available:"
  $rel.assets | ForEach-Object { Warn ("  " + $_.name) }
  Die "nothing to install for Windows"
}

$tmp = Join-Path $env:TEMP ("chates-update-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = Join-Path $tmp "setup.zip"

if(-not (Download-Asset -Url $setup.url -Dest $zip)){ Die "download failed" }
Say ("downloaded " + [math]::Round((Get-Item $zip).Length/1MB,1) + " MB")

# 解包 → 里面就是安装器那套文件
$stage = Join-Path $tmp "stage"
try { Expand-Archive -Path $zip -DestinationPath $stage -Force }
catch { Die ("unzip failed: " + $_.Exception.Message) }

$newInstaller = Join-Path $stage "install.ps1"
if(-not (Test-Path $newInstaller)){ Die "update package has no install.ps1 — refusing to continue" }

# 数据目录要保住：更新只换代码，不碰 home\data 里的会话/配置/技能
Say "stopping running services..."
Stop-HermesProcess

Say "applying update (keeps your data)..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $newInstaller -Silent -Force
if($LASTEXITCODE -ne 0){ Die ("installer returned " + $LASTEXITCODE) }

# install.ps1 会把 version.json 写到 $Root，确认真的更新了
$after = Get-CurrentVersion
if((Compare-Ver $after $latest) -lt 0){
  Warn ("version file still says " + $after + " — update may be incomplete")
} else {
  Say ("updated to " + $after)
}

# 重开面板
$vbs = Join-Path $Root "后台启动.vbs"
if(Test-Path $vbs){ Start-Process "wscript.exe" -ArgumentList "`"$vbs`"" -WindowStyle Hidden }
Say "panel restarted. open the desktop icon."

# 清理临时
try { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch {}

if(-not $Silent){ Start-Sleep -Seconds 3 }
exit 0
