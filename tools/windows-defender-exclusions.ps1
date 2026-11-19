<#
.SYNOPSIS
  Adds Microsoft Defender exclusions that stop real-time scanning from saturating the CPU while the harness runs,
  or removes exactly the exclusions this script added.

.DESCRIPTION
  The harness and Claude Code start many short processes (node, bash, git, codex) and touch many small files
  (node_modules, .git, logs). Defender's real-time protection scans each one, which can keep the CPU busy.
  This script excludes the harness folders, the npm and Codex folders, the folders you name with -ExtraPath
  (your project folders), and the executables of those tools. Excluded paths and processes are NOT scanned:
  keep only trusted folders there. It is a security trade-off; the machine's owner decides and runs it.

  Run in an elevated PowerShell (Run as administrator). It shows the list and asks before changing anything.
  Every exclusion it adds is recorded in %USERPROFILE%\.claude\luna-run\defender-exclusions.json, so -Remove
  takes back only those, never exclusions you added yourself.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\windows-defender-exclusions.ps1 -ExtraPath C:\dev
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\windows-defender-exclusions.ps1 -Remove
#>
param(
  [string[]]$ExtraPath = @(),
  [switch]$Remove,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Run this script in an elevated PowerShell (Run as administrator).'
  exit 1
}
if (-not (Get-Command Add-MpPreference -ErrorAction SilentlyContinue)) {
  Write-Host 'Microsoft Defender cmdlets are not available on this machine; nothing to do.'
  exit 0
}

$record = Join-Path $env:USERPROFILE '.claude\luna-run\defender-exclusions.json'

if ($Remove) {
  if (-not (Test-Path $record)) { Write-Host "Nothing recorded in $record; nothing to remove."; exit 0 }
  $saved = Get-Content $record -Raw | ConvertFrom-Json
  Write-Host 'Will remove these exclusions (added by this script):'
  $saved.paths | ForEach-Object { Write-Host "  path     $_" }
  $saved.processes | ForEach-Object { Write-Host "  process  $_" }
  if (-not $Yes -and (Read-Host 'Remove them? [y/N]') -notmatch '^[yY]') { Write-Host 'Nothing changed.'; exit 0 }
  if ($saved.paths) { Remove-MpPreference -ExclusionPath $saved.paths }
  if ($saved.processes) { Remove-MpPreference -ExclusionProcess $saved.processes }
  Remove-Item $record
  Write-Host 'Removed.'
  exit 0
}

# Folders: the harness home, Codex home, npm global packages and cache, the custom Codex build, and the owner's
# project folders. Only folders that exist are added.
$paths = @(
  (Join-Path $env:USERPROFILE '.claude'),
  (Join-Path $env:USERPROFILE '.codex'),
  (Join-Path $env:APPDATA 'npm'),
  (Join-Path $env:LOCALAPPDATA 'npm-cache')
)
$envFile = Join-Path $env:USERPROFILE '.claude\luna-harness.env'
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^\s*(export\s+)?LUNA_CODEX_BUILD_ROOT=' } | Select-Object -First 1
  if ($line) { $paths += ($line -replace '^\s*(export\s+)?LUNA_CODEX_BUILD_ROOT=', '').Trim('"', "'", ' ') }
}
$paths += $ExtraPath
$paths = $paths | Where-Object { $_ -and (Test-Path $_) } | ForEach-Object { (Resolve-Path $_).Path } | Select-Object -Unique

# Processes: the exact executables found on this machine (full paths, so other programs with the same file name stay
# scanned).
$processes = @()
foreach ($name in @('node', 'git', 'bash', 'codex')) {
  $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $processes += $cmd.Source }
}
foreach ($candidate in @("$env:ProgramFiles\Git\bin\bash.exe", "$env:ProgramFiles\Git\usr\bin\bash.exe",
                         "$env:ProgramFiles\Git\cmd\git.exe", (Join-Path $env:USERPROFILE '.claude\bin\luna-sh\sh.exe'))) {
  if (Test-Path $candidate) { $processes += (Resolve-Path $candidate).Path }
}
$processes = $processes | Where-Object { $_ -and $_ -notmatch '\.(cmd|ps1|bat)$' } | Select-Object -Unique

$current = Get-MpPreference
$newPaths = @($paths | Where-Object { $current.ExclusionPath -notcontains $_ })
$newProcesses = @($processes | Where-Object { $current.ExclusionProcess -notcontains $_ })

if (-not $newPaths -and -not $newProcesses) { Write-Host 'All exclusions are already present; nothing to add.'; exit 0 }
Write-Host 'Defender will stop scanning these (trusted harness and project locations only):'
$newPaths | ForEach-Object { Write-Host "  path     $_" }
$newProcesses | ForEach-Object { Write-Host "  process  $_" }
if (-not $Yes -and (Read-Host 'Add them? [y/N]') -notmatch '^[yY]') { Write-Host 'Nothing changed.'; exit 0 }

if ($newPaths) { Add-MpPreference -ExclusionPath $newPaths }
if ($newProcesses) { Add-MpPreference -ExclusionProcess $newProcesses }

$previous = if (Test-Path $record) { Get-Content $record -Raw | ConvertFrom-Json } else { $null }
New-Item -ItemType Directory -Force -Path (Split-Path $record) | Out-Null
[pscustomobject]@{
  paths = @($previous.paths) + $newPaths | Where-Object { $_ } | Select-Object -Unique
  processes = @($previous.processes) + $newProcesses | Where-Object { $_ } | Select-Object -Unique
  at = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Path $record -Encoding UTF8
Write-Host "Added. Recorded in $record; run with -Remove to take back exactly these."
