# Luna shell patch for Codex rust-v0.164.0

Select a lightweight shell for local model commands without changing the normal Codex installation.
Omitting `default_shell` preserves upstream selection, argv, instructions, and sandbox behavior.

```toml
default_shell = "sh"
default_shell_path = "C:/Users/PC/.claude/bin/luna-sh/sh.exe"
```

`default_shell` accepts `powershell`, `cmd`, `sh`, `bash`, or `zsh`, case-insensitively.
`default_shell_path` is optional. When the type is configured, a supplied path must be absolute and
name an existing file. Without a path, discovery must find that type; failures are startup errors.
A path without a type is ignored. Test shell overrides still take precedence.

Both settings use ordinary config layering: config.toml, CLI `-c`, and app-server `thread/start.config`.
The request path is `thread_processor::thread_start` -> `ConfigManager::load_with_overrides` ->
`load_with_cli_overrides`, which converts request JSON values to TOML and merges them into CLI overrides.
This was checked in source, not through a running app-server.

With a configured type, model `shell` arguments are ignored and debug-logged. Direct execution prevents
the zsh-fork feature from substituting a packaged executable. Remote environments retain their native shell.
Windows POSIX and cmd guidance matches the selected shell. The required POSIX note includes the phrase
"there is no PowerShell"; PowerShell-specific instructions are removed. PowerShell guidance is unchanged.
Windows sh snapshots are unsupported. The UTF-8 prefix remains exclusive to PowerShell; sandbox policy,
executor routing, and restricted-token spawning are unchanged. Windows bash/zsh remain untested.

Upstream sh uses `-lc` for login shells and `-c` otherwise. Set `allow_login_shell = false` if desired;
this patch does not change that default or strip the model's `login` setting.

## Files in luna-shell.patch

Paths below are relative to `codex-rs/`:

| File | Purpose |
| --- | --- |
| `config.md` | Document the local configuration keys and behavior. |
| `config/src/config_toml.rs` | Parse shell types case-insensitively; config parsing tests. |
| `core/config.schema.json` | Add the shell type enum and both optional keys. |
| `core/src/config/mod.rs` | Carry both settings into runtime config. |
| `core/src/config/config_tests.rs` | Verify TOML and CLI override layering for both keys. |
| `core/src/shell.rs` | Select shells with explicit errors and existing fallback precedence. |
| `core/src/configured_shell_tests.rs` | Selection, validation, override precedence, and sh argv tests. |
| `core/src/session/session.rs` | Use shell selection and preserve explicit shell precedence, including review turns. |
| `core/src/tools/handlers/unified_exec.rs` | Ignore model shell requests for configured sessions. |
| `core/src/tools/handlers/unified_exec/exec_command.rs` | Pass shell policy and guidance through the handler. |
| `core/src/tools/handlers/unified_exec_tests.rs` | Update callers and test configured/unconfigured requests. |
| `core/src/tools/handlers/shell_spec.rs` | Make tool guidance and shell parameter text shell-aware. |
| `core/src/tools/handlers/shell_spec_tests.rs` | POSIX, cmd, and unchanged PowerShell guidance tests. |
| `core/src/tools/spec_plan.rs` | Pass the actual selected environment shell into tool generation. |
| `core/src/tools/spec_plan_tests.rs` | Check Windows sh guidance through tool planning. |
| `core/src/tools/runtimes/unified_exec.rs` | Isolate and test the existing PowerShell-only UTF-8 guard. |
| `core/src/shell_snapshot.rs` | Skip Windows sh capture and reject direct snapshot writes. |
| `core/src/shell_snapshot_tests.rs` | Reject Windows sh snapshots before spawning a process. |
| `core/src/context/world_state/environment_render_tests.rs` | Verify Windows sh environment context. |
| `thread-manager-sample/src/main.rs` | Initialize the new runtime config fields in the sample. |

`LUNA-PATCH.md` documents the patch; `luna-shell.patch` contains the source diff and the new test file.
The pre-existing Cargo.lock modifications are deliberately excluded. Nothing was committed or staged.
The requested parent-directory destinations are outside this executor's writable root, so both artifacts
are delivered in `E:/codex-build/codex/`; copy them to `E:/codex-build/` from the orchestrator if required.

## Rebuild and verify (orchestrator)

From `E:/codex-build/codex/codex-rs`, use the existing Windows Rust build environment:

```powershell
cargo run -p codex-config-schema --bin codex-write-config-schema
cargo test -p codex-config default_shell
cargo test -p codex-core --lib configured_shell
cargo test -p codex-core --lib default_shell_loads_from_toml_and_cli_overrides
cargo test -p codex-core --lib configured_windows
cargo test -p codex-core --lib tools::handlers::shell_spec::tests
cargo test -p codex-core --lib utf8_prefix_is_only_applied_to_powershell
cargo test -p codex-core --lib windows_sh_snapshot_is_unsupported_without_spawning
cargo test -p codex-core --lib serialize_windows_sh_environment_context
cargo check -p codex-thread-manager-sample
cargo build -p codex-cli --release --bin codex
```

The sample package is `codex-thread-manager-sample`; confirm its name against Cargo.toml after upgrading.
Use `target/release/codex.exe` by explicit path in wrappers. Leave the user's installed Codex alone.
Smoke-test config.toml, app-server process `-c`, thread/start.config, ignored model `shell = "powershell"`,
and read-only sandbox writes with the real busybox executable on disposable data.

No Cargo command was run by this executor. Eighteen Rust tests were added. Static verification includes
rustfmt checks for all 20 edited Rust files, diff whitespace checks, and usage scans. Rustfmt also reflows
some existing session initialization code after shell selection was extracted; those changes are formatting only.
The schema was updated manually to match its derives; regeneration and compilation still need the
orchestrator's Rust environment.

## Reapply to a newer tag

Use a clean checkout of the intended upstream tag, then from its repository root:

```powershell
git apply --check E:/codex-build/luna-shell.patch
git apply E:/codex-build/luna-shell.patch
```

If context has moved, port only the files and behaviors listed above. Inspect the current equivalents of
config loading, session shell selection, per-command overrides, tool guidance, snapshots, and Windows
command preparation. Keep default behavior and sandbox routing intact; regenerate the schema and rerun
the tests/build above on Windows, plus compile checks on Linux/macOS before adopting the new binary.
Export a fresh diff against the newer tag, explicitly excluding unrelated local changes and including
the new test file. This patch does not include the documentation file or recursively include itself.
