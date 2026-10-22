[CmdletBinding()]
param(
    [string]$BuildRoot = (Join-Path $env:USERPROFILE 'codex-build'),
    [ValidateRange(1, 256)]
    [int]$Jobs = 2,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]*$')]
    [string]$Profile = 'release'
)

$ErrorActionPreference = 'Stop'
$BuildRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BuildRoot)
$source = Join-Path $BuildRoot 'codex\codex-rs'
if (-not (Test-Path -LiteralPath (Join-Path $source 'Cargo.toml') -PathType Leaf)) {
    throw 'Source not found. Run setup-source.ps1 with the same -BuildRoot first.'
}

# Keep the caller's PATH, including Git and other installed build dependencies.
$env:PATH = "$(Join-Path $env:USERPROFILE '.cargo\bin');$env:PATH"
foreach ($tool in 'cargo', 'rustc') {
    if (-not (Get-Command $tool -CommandType Application -ErrorAction SilentlyContinue)) {
        throw "$tool is missing from PATH. Install Rustlang.Rustup and Rust 1.95.0; see BUILD.md."
    }
}
$rustVersion = & rustc --version
if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch '^rustc 1\.95\.') {
    throw "Rust 1.95.x is required; found '$rustVersion'. Run rustup toolchain install 1.95.0 and rustup default 1.95.0."
}
$rustDetails = & rustc -vV
if ($LASTEXITCODE -ne 0 -or -not ($rustDetails -match '^host: x86_64-pc-windows-msvc$')) {
    throw 'Use the x86_64-pc-windows-msvc Rust toolchain; the distribution is Windows x64 MSVC only.'
}

$driveRoot = [IO.Path]::GetPathRoot($BuildRoot)
if ($driveRoot -notmatch '^[A-Za-z]:\\$') {
    throw 'BuildRoot must be on a local Windows drive so its free space can be checked.'
}
$driveId = $driveRoot.Substring(0, 2)
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$driveId'"
if (-not $disk -or $disk.FreeSpace -lt 15GB) {
    throw "At least 15 GB free is required on $driveId for BuildRoot $BuildRoot."
}
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $freeRam = [double]$os.FreePhysicalMemory * 1KB
    if ($freeRam -lt 4GB) {
        Write-Warning ('Only {0:N1} GB RAM is free; at least 4 GB is recommended. Keep -Jobs 2.' -f ($freeRam / 1GB))
    }
} catch {
    Write-Warning "Could not check free RAM: $_"
}

$vswhereCommand = Get-Command vswhere.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($vswhereCommand) {
    $vswhere = $vswhereCommand.Source
} else {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
}
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw 'vswhere.exe is missing. Install Visual Studio 2022 Build Tools with the C++ workload; see BUILD.md.'
}
$vsArgs = @(
    '-latest', '-version', '[17.0,18.0)', '-products', 'Microsoft.VisualStudio.Product.BuildTools',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    'Microsoft.VisualStudio.Component.Windows11SDK.26100', '-property', 'installationPath'
)
$vsRoot = & $vswhere @vsArgs
if ($LASTEXITCODE -ne 0 -or -not $vsRoot) {
    throw 'VS 2022 Build Tools needs MSVC v143 x64/x86 and Windows 11 SDK 10.0.26100; see BUILD.md.'
}
$devCmd = Join-Path $vsRoot 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $devCmd -PathType Leaf)) {
    throw "Visual Studio environment script not found: $devCmd"
}
# Import the SDK, include/library paths, and x64 compiler into this process only.
$devEnvironment = & $env:ComSpec /d /c "`"$devCmd`" -no_logo -arch=x64 -host_arch=x64 && set"
if ($LASTEXITCODE -ne 0) {
    throw 'Could not initialize the Visual Studio x64 build environment.'
}
foreach ($line in $devEnvironment) {
    if ($line -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
if (-not (Get-Command cl.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'cl.exe is not reachable after initializing the Build Tools installation found by vswhere.'
}

$env:CARGO_HOME = Join-Path $BuildRoot 'cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $BuildRoot 'target'
$env:CARGO_BUILD_JOBS = "$Jobs"
$log = Join-Path $BuildRoot 'build.log'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$start = Get-Date
Push-Location -LiteralPath $source
try {
    # Windows PowerShell treats native stderr as ErrorRecords; Cargo writes progress there.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        cargo build --profile $Profile --bin codex 2>&1 |
            ForEach-Object { "$_" } | Tee-Object -FilePath $log | Select-Object -Last 25
        $buildExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
} finally {
    Pop-Location
}
Write-Host ('build exit={0} minutes={1:N1}' -f $buildExit, ((Get-Date) - $start).TotalMinutes)
if ($buildExit -ne 0) {
    throw "Cargo failed with exit code $buildExit. See $log"
}
