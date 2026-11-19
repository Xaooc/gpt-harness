<#
.SYNOPSIS
  Adds Microsoft Defender exclusions that stop real-time scanning from saturating the CPU while the harness runs,
  or removes exactly the exclusions this script added.

.DESCRIPTION
  The harness and Claude Code start many short processes (node, bash, git, codex) and touch many small files
  (node_modules, .git, logs). Defender's real-time protection scans each one, which can keep the CPU busy.
  This script excludes the harness folders, the npm and Codex folders, the custom Codex build, the folders you name
  with -ExtraPath (your project folders), and the executables of those tools. Excluded paths and processes are NOT
  scanned: keep only trusted folders there. It is a security trade-off; the machine's owner decides and runs it.

  Run in an elevated PowerShell (Run as administrator). It shows the list and asks before changing anything.
  Every exclusion it adds is recorded in %ProgramData%\LunaHarness\defender-exclusions.json, a file only
  administrators can change. The record is written before Defender is changed and reconciled with Defender's real
  state afterwards, so -Remove takes back only exclusions this script added, never ones you added yourself.

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

$recordDir = Join-Path $env:ProgramData 'LunaHarness'
$record = Join-Path $recordDir 'defender-exclusions.json'
$adminsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$usersSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
# Owners and writers a record may have: Administrators, SYSTEM, TrustedInstaller.
$trustedSids = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$writeRights = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'

function Protect-Item([string]$Path, [switch]$Directory) {
  $acl = if ($Directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
  $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $none = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $acl.SetOwner($adminsSid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($adminsSid, 'FullControl', $inherit, $none, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', $inherit, $none, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($usersSid, 'ReadAndExecute', $inherit, $none, $allow)))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

# A record counts as proof of what this script added only if no one but administrators could have written it.
function Test-AdminOnly([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($trustedSids -notcontains $owner) { return $false }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    if ($trustedSids -contains $rule.IdentityReference.Value) { continue }
    if (($rule.FileSystemRights -band $writeRights) -ne 0) { return $false }
  }
  return $true
}

function Read-Record {
  if (-not (Test-Path -LiteralPath $record)) { return [pscustomobject]@{ paths = @(); processes = @(); pending = $null } }
  if (-not (Test-AdminOnly $recordDir) -or -not (Test-AdminOnly $record)) {
    throw "$record can be changed by non-administrators, so it cannot prove which exclusions this script added. " +
      'Inspect it and Defender''s exclusions by hand, delete it, then run this script again.'
  }
  try { $saved = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json }
  catch { throw "$record is not valid JSON; inspect it and Defender's exclusions by hand. Nothing was changed." }
  return [pscustomobject]@{
    paths = @($saved.paths | Where-Object { $_ })
    processes = @($saved.processes | Where-Object { $_ })
    pending = $saved.pending
  }
}

# Writes a sibling temp file with the protected ACL, then swaps it in, so the record is never half-written.
function Write-Record([string[]]$Paths, [string[]]$Processes, $Pending) {
  if (-not (Test-Path -LiteralPath $recordDir)) { New-Item -ItemType Directory -Path $recordDir | Out-Null }
  Protect-Item $recordDir -Directory
  $json = [pscustomobject]@{
    paths = @($Paths | Where-Object { $_ } | Select-Object -Unique)
    processes = @($Processes | Where-Object { $_ } | Select-Object -Unique)
    pending = $Pending
    at = (Get-Date).ToString('o')
  } | ConvertTo-Json -Depth 4
  $tmp = Join-Path $recordDir ("defender-exclusions.$PID.tmp")
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
  Protect-Item $tmp
  if (Test-Path -LiteralPath $record) { [IO.File]::Replace($tmp, $record, $null) } else { [IO.File]::Move($tmp, $record) }
}

# Entries planned by a run that stopped before it could reconcile: keep those Defender has (they were absent when
# that run planned them), drop the rest.
function Resolve-Pending($Saved) {
  if (-not $Saved.pending) { return $Saved }
  $current = Get-MpPreference
  $Saved.paths = @($Saved.paths | Where-Object { @($Saved.pending.paths) -notcontains $_ -or $current.ExclusionPath -contains $_ })
  $Saved.processes = @($Saved.processes | Where-Object { @($Saved.pending.processes) -notcontains $_ -or $current.ExclusionProcess -contains $_ })
  Write-Record $Saved.paths $Saved.processes $null
  $Saved.pending = $null
  return $Saved
}

$mutex = New-Object Threading.Mutex($false, 'Global\LunaHarnessDefenderExclusions')
try {
  try { if (-not $mutex.WaitOne(60000)) { Write-Host 'Another run of this script is still working; try again later.'; exit 1 } }
  catch [Threading.AbandonedMutexException] { }

  $saved = Resolve-Pending (Read-Record)

  if ($Remove) {
    $current = Get-MpPreference
    $removePaths = @($saved.paths | Where-Object { $current.ExclusionPath -contains $_ })
    $removeProcesses = @($saved.processes | Where-Object { $current.ExclusionProcess -contains $_ })
    if (-not $removePaths -and -not $removeProcesses) {
      if (Test-Path -LiteralPath $record) { Remove-Item -LiteralPath $record }
      Write-Host 'No exclusions added by this script are present; nothing to remove.'
      exit 0
    }
    Write-Host 'Will remove these exclusions (added by this script):'
    $removePaths | ForEach-Object { Write-Host "  path     $_" }
    $removeProcesses | ForEach-Object { Write-Host "  process  $_" }
    if (-not $Yes -and (Read-Host 'Remove them? [y/N]') -notmatch '^[yY]') { Write-Host 'Nothing changed.'; exit 0 }
    try {
      if ($removePaths) { Remove-MpPreference -ExclusionPath $removePaths }
      if ($removeProcesses) { Remove-MpPreference -ExclusionProcess $removeProcesses }
    } finally {
      # Keep in the record whatever is still present, so a failed removal can be retried.
      $after = Get-MpPreference
      $leftPaths = @($saved.paths | Where-Object { $after.ExclusionPath -contains $_ })
      $leftProcesses = @($saved.processes | Where-Object { $after.ExclusionProcess -contains $_ })
      if ($leftPaths -or $leftProcesses) { Write-Record $leftPaths $leftProcesses $null }
      else { Remove-Item -LiteralPath $record }
    }
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
  # The installer records the custom Codex build root in luna-harness.env (default %USERPROFILE%\codex-build).
  $buildRoot = Join-Path $env:USERPROFILE 'codex-build'
  $envFile = Join-Path $env:USERPROFILE '.claude\luna-harness.env'
  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*LUNA_CUSTOM_CODEX_ROOT=' } | Select-Object -First 1
    if ($line) { $buildRoot = ($line -replace '^\s*LUNA_CUSTOM_CODEX_ROOT=', '').Trim('"', "'", ' ') }
  }
  $paths += $buildRoot
  $paths += $ExtraPath
  $paths = @($paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | ForEach-Object { (Resolve-Path -LiteralPath $_).Path } | Select-Object -Unique)

  # Processes: the exact native executables found on this machine (full paths, so other programs with the same file
  # name stay scanned). Shims (.cmd/.ps1/.bat) are resolved to the native binary they start; Windows' own binaries
  # (for example the WSL bash.exe launcher in System32) are never excluded.
  $processes = @()
  foreach ($name in @('node', 'git', 'bash')) {
    $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -match '\.exe$' } | Select-Object -First 1
    if ($cmd) { $processes += $cmd.Source }
  }
  $npmCodex = Join-Path $env:APPDATA 'npm\node_modules\@openai'
  if (Test-Path -LiteralPath $npmCodex) {
    $processes += @(Get-ChildItem -LiteralPath $npmCodex -Recurse -Filter 'codex.exe' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  foreach ($candidate in @((Join-Path $buildRoot 'dist\bin\codex.exe'), "$env:ProgramFiles\Git\bin\bash.exe",
                           "$env:ProgramFiles\Git\usr\bin\bash.exe", "$env:ProgramFiles\Git\cmd\git.exe",
                           (Join-Path $env:USERPROFILE '.claude\bin\luna-sh\sh.exe'))) {
    if (Test-Path -LiteralPath $candidate) { $processes += (Resolve-Path -LiteralPath $candidate).Path }
  }
  $systemRoot = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\') + '\'
  $processes = @($processes | Where-Object {
      $_ -and $_ -match '\.exe$' -and -not $_.StartsWith($systemRoot, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -Unique)

  $current = Get-MpPreference
  $newPaths = @($paths | Where-Object { $current.ExclusionPath -notcontains $_ })
  $newProcesses = @($processes | Where-Object { $current.ExclusionProcess -notcontains $_ })

  if (-not $newPaths -and -not $newProcesses) { Write-Host 'All exclusions are already present; nothing to add.'; exit 0 }
  Write-Host 'Defender will stop scanning these (trusted harness and project locations only):'
  $newPaths | ForEach-Object { Write-Host "  path     $_" }
  $newProcesses | ForEach-Object { Write-Host "  process  $_" }
  if (-not $Yes -and (Read-Host 'Add them? [y/N]') -notmatch '^[yY]') { Write-Host 'Nothing changed.'; exit 0 }

  # Record first (marked pending), change Defender, then keep in the record exactly what Defender now has.
  Write-Record ($saved.paths + $newPaths) ($saved.processes + $newProcesses) ([pscustomobject]@{ paths = $newPaths; processes = $newProcesses })
  try {
    if ($newPaths) { Add-MpPreference -ExclusionPath $newPaths }
    if ($newProcesses) { Add-MpPreference -ExclusionProcess $newProcesses }
  } finally {
    $after = Get-MpPreference
    $addedPaths = @($newPaths | Where-Object { $after.ExclusionPath -contains $_ })
    $addedProcesses = @($newProcesses | Where-Object { $after.ExclusionProcess -contains $_ })
    Write-Record ($saved.paths + $addedPaths) ($saved.processes + $addedProcesses) $null
  }
  Write-Host "Added. Recorded in $record; run with -Remove to take back exactly these."
} finally {
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
