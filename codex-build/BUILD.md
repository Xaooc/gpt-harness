# Build the Luna Codex binary on Windows

This kit reproduces Codex `rust-v0.162.1` with `luna-shell.patch` at
`<BuildRoot>\dist\bin\codex.exe`. The patch adds `default_shell` and `default_shell_path` so Luna can run
commands with busybox `sh` (about 5-7 MB per process) instead of PowerShell (about 65 MB).

The default BuildRoot is `$env:USERPROFILE\codex-build`. Choose a local drive with at least 15 GB free.
The original release build took **65m 20s**, peaked near **7 GB RAM**, and used about **8 GB target files**
plus **2.3 GB Cargo home**. Allow extra disk for the checkout, distribution, downloads, and installers.
Use a 16 GB RAM machine if possible, keep at least 4 GB free before starting, and use **two jobs**.
Keep free space on C: as well: the Windows SDK installs there even when BuildRoot is on another drive.

## Permission and download boundaries

An autonomous agent must **ask its user before downloading/installing prerequisites, cloning source,
or starting the first build**, which downloads Cargo dependencies and occupies substantial resources.
Approval for the stated operation covers its listed downloads; do not repeatedly ask for the same approval.
Never elevate the source, build, assembly, or harness steps just because prerequisite installation needed elevation.

| Operation | Administrator rights | Download/network |
| --- | --- | --- |
| Visual Studio Build Tools + Windows SDK | Yes (UAC/elevated shell) | Yes; large download |
| Git via winget | Normally yes for a machine install | Yes |
| Rustup via winget, Rust 1.95.0 toolchain | Normally no for user install | Yes |
| Node.js/npm if absent | Depends on installer/scope | Yes |
| Pinned global npm Codex | No with a user-owned npm prefix; otherwise depends on prefix | Yes |
| `setup-source.ps1` first run | No | Yes: shallow Git clone |
| `setup-source.ps1` on the existing correct checkout | No | No |
| `build.ps1` | No | Yes on first build or uncached dependencies |
| `assemble-dist.ps1` | No | No: uses local npm artifacts |
| `node install.mjs --codex-build-root ...` | No | Local payload installation; see `../INSTALL.md` |
| Luna readiness job | No | Yes: authenticated Codex request |

## Prerequisites

Use **Windows 10/11 x64**, Windows PowerShell 5.1 or newer, and a normal user-owned BuildRoot.
The harness also needs Node.js **20 or newer**, npm, Git Bash for its wrapper, and an authenticated
Codex CLI (`codex login` after installing it). Install Node.js/npm through the harness prerequisites
in `../INSTALL.md` if missing. Git.Git supplies Git Bash; it is used to launch Luna, not as Codex's shell.

After user approval, install Git and the C++ tools. The Build Tools command requires administrator
rights and a download. Git installation can also prompt for elevation. Run these in PowerShell:

```powershell
winget install --exact --id Git.Git
$vsComponents = '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools' +
    ' --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64' +
    ' --add Microsoft.VisualStudio.Component.Windows11SDK.26100'
winget install --exact --id Microsoft.VisualStudio.2022.BuildTools --override $vsComponents
```

The components are the C++ build workload, MSVC v143 x64/x86 tools, and Windows 11 SDK 10.0.26100.
See Microsoft's [Build Tools component IDs][components] and [installer parameters][parameters].
If Build Tools is already installed without these components, use Visual Studio Installer's **Modify**
action to add them; winget may report the existing package without adding missing components.

After user approval, install Rustup and the pinned toolchain (downloads; normally no administrator
rights for a user installation). Reopen PowerShell after winget so PATH is refreshed:

```powershell
winget install --exact --id Rustlang.Rustup
# Reopen PowerShell here before continuing.
rustup toolchain install 1.95.0
rustup default 1.95.0
rustc --version
rustc -vV
```

Expect `rustc 1.95.0 ...` and host `x86_64-pc-windows-msvc`. If the host is GNU or ARM64, explicitly install
and select `1.95.0-x86_64-pc-windows-msvc` with the same two rustup commands instead.
`build.ps1` accepts `rustc 1.95.x` and rejects a different host or version family.

Install the **same-version** npm package after user approval (download; no elevation with a user-owned npm prefix):

```powershell
npm i -g @openai/codex@0.162.1
```

Do not omit optional dependencies: its Windows x64 platform package supplies `codex-path\rg.exe`,
`codex-resources\*`, `bin\codex-code-mode-host.exe`, and `codex-package.json` for the distribution.
The Rust build alone does not produce this complete runtime layout.

## Four steps

Run from the cloned **luna-harness repository root** in PowerShell. Keep the same BuildRoot in every step:

```powershell
$BuildRoot = Join-Path $env:USERPROFILE 'codex-build'
# Or select another local drive with sufficient free space.
```

### 1. Set up source (download on first run; ask first; no admin)

```powershell
& .\codex-build\setup-source.ps1 -BuildRoot $BuildRoot -Tag rust-v0.162.1
```

This finds Git on PATH, shallow-clones the tag into `<BuildRoot>\codex` if absent, verifies HEAD equals
that tag's commit, checks the patch, then applies it. A successful reverse check reports that the patch
is already applied and skips it. A different HEAD or conflicting patch stops with an error; the script
does not reset, switch, or discard an existing checkout. Patch paths are relative to the source repository root.

### 2. Build in the background (downloads dependencies; ask first; no admin)

Do not run other heavy work while this build runs. Keep `-Jobs 2`, including on a 16 GB machine.
Launch a hidden background PowerShell process so the agent can monitor it without a foreground hour-long command:

```powershell
$buildScript = (Resolve-Path .\codex-build\build.ps1).Path
$powershellExe = (Get-Command powershell.exe).Source
$buildArgs = '-NoProfile -File "{0}" -BuildRoot "{1}" -Jobs 2 -Profile release' -f $buildScript, $BuildRoot
$build = Start-Process -FilePath $powershellExe -ArgumentList $buildArgs -WindowStyle Hidden -PassThru
$build.Id
```

No execution-policy bypass is required by this kit. If local policy blocks scripts, ask the user to choose
an approved execution method. Do not silently change their machine's execution policy.

Monitor without starting another build:

```powershell
Get-Process -Id $build.Id -ErrorAction SilentlyContinue
Get-Content -LiteralPath (Join-Path $BuildRoot 'build.log') -Tail 25
```

The script finds VS 2022 Build Tools with `vswhere`, initializes its x64 environment, and checks `cl.exe`,
Rust 1.95.x, the MSVC host, and at least 15 GB free disk. Low free RAM (below 4 GB) warns without blocking.
It preserves the current PATH, adds `$env:USERPROFILE\.cargo\bin`, and sets:

```text
CARGO_HOME=<BuildRoot>\cargo-home
CARGO_TARGET_DIR=<BuildRoot>\target
CARGO_BUILD_JOBS=2
```

From `<BuildRoot>\codex\codex-rs`, it runs the original command exactly:

```powershell
cargo build --profile $Profile --bin codex
```

There is no added `-p` package selection or `--locked` flag. `CARGO_BUILD_JOBS` sets parallelism.
The process has BelowNormal priority. Cargo output goes to `<BuildRoot>\build.log` (replaced per build).
Failure exits nonzero. The log can contain warnings and `System.Management.Automation.RemoteException`
lines from PowerShell's native stderr handling; inspect the actual Cargo result.

After the process finishes, check its exit code before assembly:

```powershell
$build.WaitForExit()
if ($build.ExitCode -ne 0) { throw "Build failed (exit $($build.ExitCode)); inspect build.log." }
Test-Path -LiteralPath (Join-Path $BuildRoot 'target\release\codex.exe')
```

Use the bounded monitoring calls above until the process has exited before calling `WaitForExit()`.
Pre-check failures occur before the Cargo log starts; if no new log appears and the process exits,
run `build.ps1` in a visible PowerShell terminal to read the pre-check error before retrying the background launch.

### 3. Assemble the runtime (local only; no admin)

```powershell
& .\codex-build\assemble-dist.ps1 -BuildRoot $BuildRoot
```

The default npm location is `npm root -g` plus `\@openai\codex`. Override it with
`-NpmCodexDir '<path to @openai\codex>'` if needed. The script checks npm and vendor metadata for 0.162.1,
copies the entire `vendor\x86_64-pc-windows-msvc` tree into `<BuildRoot>\dist`, then replaces only
`dist\bin\codex.exe` with `target\release\codex.exe`. It checks the final executable's version.
It supports both nested and sibling npm platform package locations. Existing distribution files are overwritten;
the script does not delete unrelated files from an existing dist directory.

If using `build.ps1 -Profile <name>`, pass the same `-Profile <name>` to assembly. Cargo's `dev`/`test`
profiles use the `debug` output directory and `bench` uses `release`; other profile names are used directly.

### 4. Point the harness to the build (local install; no admin)

```powershell
node install.mjs --codex-build-root $BuildRoot
```

This records `LUNA_CUSTOM_CODEX_ROOT` in `~/.claude/luna-harness.env`. Luna selects
`<BuildRoot>\dist\bin\codex.exe` when both it and `~/.claude/bin/luna-sh/sh.exe` exist.
The harness installer supplies that busybox executable. Luna passes these config values together:

```toml
default_shell = "sh"
default_shell_path = "C:/Users/<user>/.claude/bin/luna-sh/sh.exe"
allow_login_shell = false
```

Luna resolves the absolute shell path for the current user. `allow_login_shell=false` is required for this setup:
busybox receives `-c` rather than a login-shell invocation. See the byte-for-byte copied `LUNA-PATCH.md`
for patch semantics; its original source-machine paths and historical build notes are preserved as supplied.
Use this BUILD.md for portable paths and the verified original build command.

## Verify the assembled build and Luna

In PowerShell, verify the explicit executable rather than a stock Codex found on PATH:

```powershell
& (Join-Path $BuildRoot 'dist\bin\codex.exe') --version
```

Expected: `codex-cli 0.162.1`.

In Git Bash, wait until existing Luna jobs have finished, then stop an old daemon so the next job uses
the newly selected executable. The readiness job requires authentication and a network request; ask first
if that has not already been authorized:

```bash
node ~/.claude/scripts/luna-daemon.mjs --stop
bash ~/.claude/scripts/luna.sh -r -e low "Reply with exactly: OK"
```

Expect `OK`. The wrapper reports its output/status path; inspect that job's adjacent `<out>.status`.
It **must contain `shell=busybox-sh`**, with a successful completion state and `rc=0`.
To choose a predictable output path for a repeat check:

```bash
bash ~/.claude/scripts/luna.sh -r -e low -o "$TEMP/luna-codex-ready.md" "Reply with exactly: OK"
grep -E '^(state|rc|shell)=' "$TEMP/luna-codex-ready.md.status"
```

Do not accept `OK` alone as shell verification. If the status uses the stock shell, check the installed
root, busybox path, and any exported `LUNA_CUSTOM_CODEX=0`, `LUNA_CODEX_BIN`, or `LUNA_CUSTOM_CODEX_BIN` overrides.
Official OpenAI documentation describes the upstream
[Windows sandbox](https://developers.openai.com/codex/windows/); this kit's busybox settings are a local patch.

## Troubleshooting

- **Out of memory with four jobs:** four parallel jobs exhausted a 16 GB machine. Retry with `-Jobs 2`
  after stopping other heavy work. The existing Cargo home and target directory are reusable.
- **SDK installer error 1001/1601:** free space on C: before retrying. The Windows SDK installs to C:
  even when BuildRoot or Visual Studio is on another drive. Run the installer with the required elevation.
- **Git Bash as the Codex shell fails:** MSYS can die inside the sandbox with `CreateFileMapping error 5`.
  Use busybox `sh.exe` for model commands. Git Bash remains suitable for starting the Luna wrapper outside
  the sandbox. Do not point `default_shell_path` to Git's bash/sh. Keep `allow_login_shell=false`.
- **`rg` missing:** rerun assembly against npm Codex 0.162.1 with its Windows platform dependency installed.
  Copying only the Rust `codex.exe` omits `codex-path\rg.exe`; assembly copies that directory and resources.
- **npm version mismatch:** run `npm i -g @openai/codex@0.162.1` after approval, then assemble again.
  Missing optional vendor package: use `npm i -g @openai/codex@0.162.1 --include=optional`.
- **`cl.exe` or SDK not found:** modify the VS 2022 Build Tools installation to include all three components
  listed above. The build script discovers it with vswhere; no hard-coded Git or compiler path is needed.
- **Patch fails:** confirm HEAD is the intended tag and inspect local changes. Do not force-apply or reset
  a working checkout to silence the error. Use a separate user-approved BuildRoot if preserving other work.

## Rebuild after a Codex upgrade

This kit and npm assembly are intentionally pinned to 0.162.1. An upgrade requires a reviewed kit change,
not just passing a newer `-Tag`: the script must still assemble helpers of the same version as the new binary.

1. After user approval for downloads, use a clean checkout of the new upstream tag (for example, a fresh BuildRoot
   passed to `setup-source.ps1 -Tag <new-tag>`). Re-apply the patch with `git apply --check` before applying it.
2. If the patch no longer applies, port its config, shell selection, command override, guidance, and snapshot
   changes to the new source. Preserve sandbox routing and upstream behavior when the settings are absent.
   Regenerate the config schema and run the focused tests listed in `LUNA-PATCH.md` against the new source.
3. Export a reviewed replacement patch and update this kit's default tag, required Rust/tool prerequisites,
   assembly version checks/fix command, and expected version documentation together. Install the corresponding
   npm version after approval; never combine an old vendor tree with a newly built Codex version.
4. Repeat build, assembly, harness selection, explicit version check, and the `shell=busybox-sh` readiness check.
   Keep the previous working build until those checks succeed.

[components]: https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=vs-2022
[parameters]: https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio?view=vs-2022
