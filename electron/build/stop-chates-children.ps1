# Stop processes whose executable lives under the given install root.
# Kept as a standalone script: nesting this pipeline inside an NSIS
# nsExec::ExecToLog command string loses one quote level on each side and
# cannot be tested outside a real installer run.
param(
  [Parameter(Mandatory=$true)][string]$Root
)

$ErrorActionPreference = 'SilentlyContinue'
$root = $Root.TrimEnd('\').ToLowerInvariant()

# Only those under our own install root. Killing every node.exe would take
# down unrelated projects the user has open.
$mine = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" |
  Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.ToLowerInvariant().StartsWith($root)
  }

$n = 0
foreach ($p in $mine) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $n++ } catch {}
}
Write-Output ("stopped=" + $n)
exit 0
