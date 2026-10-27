[CmdletBinding()]
param(
    [string]$BuildRoot = (Join-Path $env:USERPROFILE 'codex-build'),
    [string]$NpmCodexDir,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]*$')]
    [string]$Profile = 'release'
)

$ErrorActionPreference = 'Stop'
$expectedVersion = '0.164.0'
$fix = 'npm i -g @openai/codex@0.164.0'
$BuildRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BuildRoot)
if (-not $NpmCodexDir) {
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) {
        throw "npm.cmd is missing from PATH. Install Node.js/npm, then run: $fix"
    }
    $npmRoot = & $npm.Source root -g
    if ($LASTEXITCODE -ne 0 -or -not $npmRoot) {
        throw 'npm root -g failed. Supply -NpmCodexDir with the path to @openai\codex.'
    }
    $NpmCodexDir = Join-Path ($npmRoot | Select-Object -Last 1) '@openai\codex'
}
$NpmCodexDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($NpmCodexDir)
$packageFile = Join-Path $NpmCodexDir 'package.json'
if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
    throw "Codex npm package not found at $NpmCodexDir. Run: $fix"
}
$package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
if ($package.name -ne '@openai/codex' -or $package.version -ne $expectedVersion) {
    throw "Expected @openai/codex $expectedVersion; found $($package.name) $($package.version). Run: $fix"
}

# npm may nest the platform package or hoist it beside @openai/codex.
$platformPackages = @(
    (Join-Path $NpmCodexDir 'node_modules\@openai\codex-win32-x64'),
    (Join-Path (Split-Path $NpmCodexDir -Parent) 'codex-win32-x64')
)
$vendor = $null
foreach ($platformPackage in $platformPackages) {
    $candidate = Join-Path $platformPackage 'vendor\x86_64-pc-windows-msvc'
    if (Test-Path -LiteralPath $candidate -PathType Container) {
        $vendor = $candidate
        break
    }
}
if (-not $vendor) {
    throw "Windows x64 vendor package is missing. Reinstall with optional dependencies: $fix --include=optional"
}
$metadata = Get-Content -LiteralPath (Join-Path $vendor 'codex-package.json') -Raw | ConvertFrom-Json
if ($metadata.version -ne $expectedVersion -or $metadata.target -ne 'x86_64-pc-windows-msvc') {
    throw "Vendor metadata does not match Windows x64 Codex $expectedVersion. Run: $fix"
}
foreach ($required in 'bin\codex-code-mode-host.exe', 'codex-path\rg.exe', 'codex-resources') {
    if (-not (Test-Path -LiteralPath (Join-Path $vendor $required))) {
        throw "Vendor artifact $required is missing. Reinstall the npm package: $fix"
    }
}
$profileDirectory = switch ($Profile) {
    'dev' { 'debug' }
    'test' { 'debug' }
    'bench' { 'release' }
    default { $Profile }
}
$builtBinary = Join-Path $BuildRoot "target\$profileDirectory\codex.exe"
if (-not (Test-Path -LiteralPath $builtBinary -PathType Leaf)) {
    throw "Built binary not found: $builtBinary. Run build.ps1 -Profile $Profile with the same -BuildRoot first."
}

$dist = Join-Path $BuildRoot 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Get-ChildItem -LiteralPath $vendor -Force | Copy-Item -Destination $dist -Recurse -Force
$exe = Join-Path $dist 'bin\codex.exe'
Copy-Item -LiteralPath $builtBinary -Destination $exe -Force
$version = & $exe --version
if ($LASTEXITCODE -ne 0 -or ($version -join "`n").Trim() -ne 'codex-cli 0.164.0') {
    throw "Assembled Codex version check failed: $version"
}
Write-Host "Assembled $dist ($version), including codex-path and codex-resources."
