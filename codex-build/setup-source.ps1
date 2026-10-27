[CmdletBinding()]
param(
    [string]$BuildRoot = (Join-Path $env:USERPROFILE 'codex-build'),
    [ValidateNotNullOrEmpty()]
    [string]$Tag = 'rust-v0.164.0'
)

$ErrorActionPreference = 'Stop'
$git = (Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $git) {
    throw 'Git is missing from PATH. Install Git.Git, reopen PowerShell, and retry.'
}

$BuildRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BuildRoot)
$source = Join-Path $BuildRoot 'codex'
$patch = Join-Path $PSScriptRoot 'luna-shell.patch'
if (-not (Test-Path -LiteralPath $patch -PathType Leaf)) {
    throw "Patch not found: $patch"
}
if (-not (Test-Path -LiteralPath $source)) {
    New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
    & $git clone --depth 1 --single-branch --branch $Tag -- 'https://github.com/openai/codex.git' $source
    if ($LASTEXITCODE -ne 0) {
        throw 'Shallow clone failed. Inspect the partial checkout before retrying.'
    }
}

$top = & $git -C $source rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) {
    throw "Existing source is not a Git checkout: $source"
}
if ([IO.Path]::GetFullPath($top).TrimEnd('\') -ne [IO.Path]::GetFullPath($source).TrimEnd('\')) {
    throw "Expected a repository rooted at $source; found $top"
}
$head = & $git -C $source rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0) {
    throw 'Cannot resolve source HEAD.'
}
$tagCommit = & $git -C $source rev-parse --verify "refs/tags/${Tag}^{commit}"
if ($LASTEXITCODE -ne 0) {
    throw "Tag $Tag is absent. Use a fresh BuildRoot for this tag; the script will not reset an existing checkout."
}
if ($head -ne $tagCommit) {
    throw "HEAD $head is not $Tag ($tagCommit). Refusing to patch a different revision."
}

# A failed reverse check is expected for a clean source tree, including on PowerShell 5.1.
$savedPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $git -C $source apply --reverse --check $patch 2>$null
    $alreadyApplied = $LASTEXITCODE -eq 0
} finally {
    $ErrorActionPreference = $savedPreference
}
if ($alreadyApplied) {
    Write-Host "luna-shell.patch is already applied to $Tag; skipping."
    return
}
& $git -C $source apply --check $patch
if ($LASTEXITCODE -ne 0) {
    throw 'Patch check failed. Resolve local changes or port the patch to this tag before continuing.'
}
& $git -C $source apply $patch
if ($LASTEXITCODE -ne 0) {
    throw 'Applying luna-shell.patch failed.'
}
Write-Host "Applied luna-shell.patch to $Tag in $source"
