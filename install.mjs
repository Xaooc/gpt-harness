/**
 * Usage: node install.mjs [--home <dir>] [--platform win32|linux] [--codex-build-root <winpath>]
 *   [--dry-run] [--check] [--owner-setup] [--accept-local-drift] [--no-plugin-patch] [--yes] [--uninstall] [--help]
 * Run node install.mjs --self-test for isolated tests using a tiny temporary payload.
 */
import { selfTest } from './tests/install-self-test.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  expandRoots, loadPatchSet, matchPatch, planRoot, restorable,
} from './payload/claude/scripts/luna-harness-plugin-patch.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_SUFFIX = '.bak-luna-harness';
const BEGIN = '<!-- luna-harness:begin -->';
const END = '<!-- luna-harness:end -->';
const CHECK_TIMEOUT = 300_000;
const RECORD = 'luna-harness.installed.json';
const COLLECTOR_UNIT = 'luna-collector.service';
const COLLECTOR_SCRIPT = 'scripts/luna-collector.mjs';
const COLLECTOR_SUPERVISOR = 'scripts/luna-collector-supervisor.vbs';
const COLLECTOR_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const COLLECTOR_DEPENDENCIES = [COLLECTOR_SCRIPT, COLLECTOR_SUPERVISOR, 'scripts/luna-overview.mjs',
  'scripts/conveyor/lib/platform.mjs', 'scripts/conveyor/lib/sessions.mjs', 'scripts/conveyor/lib/orchestration.mjs',
  'scripts/conveyor/usage.mjs', 'scripts/conveyor/gemini-quota.mjs', 'scripts/learning/common.mjs',
  'scripts/lib/luna-runtime.mjs', 'scripts/lib/process-identity.mjs'];
const USAGE = 'Usage: node install.mjs [--home <dir>] [--platform win32|linux] [--codex-build-root <winpath>]\n'
  + '  [--dry-run] [--check] [--owner-setup] [--accept-local-drift] [--no-plugin-patch] [--yes] [--uninstall] [--self-test] [--help]\n'
  + '--owner-setup: install pending external tools. Exits 4 if required entries are still pending.\n'
  + 'External commands are listed in preview mode, during --check, and without --owner-setup.\n'
  + '--accept-local-drift: back up local edits and replace them; otherwise drift exits 3 before any writes.\n'
  + 'A three-way merge is the usual fix for local drift. --dry-run and --check also list drift.';

function parseArgs(args) {
  const options = { home: os.homedir(), platform: process.platform };
  let platformExplicit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--home' || arg === '--codex-build-root' || arg === '--platform') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = arg === '--home' ? 'home' : arg === '--platform' ? 'platform' : 'codexBuildRoot';
      options[key] = value;
      if (arg === '--platform') platformExplicit = true;
    } else {
      const flags = {
        '--dry-run': 'dryRun', '--check': 'check', '--no-plugin-patch': 'noPluginPatch',
        '--yes': 'yes', '--self-test': 'selfTest', '--uninstall': 'uninstall', '--help': 'help',
        '--accept-local-drift': 'acceptLocalDrift', '--owner-setup': 'ownerSetup',
      };
      if (!flags[arg]) throw new Error(`Unknown option: ${arg}`);
      options[flags[arg]] = true;
    }
  }
  if (!['win32', 'linux'].includes(options.platform) && (platformExplicit || (!options.help && !options.selfTest))) {
    throw new Error(`Unsupported platform: ${options.platform}; expected win32 or linux`);
  }
  options.home = path.resolve(options.home);
  options.payload = path.join(REPO_ROOT, options.platform === 'linux' ? 'payload-linux' : 'payload');
  return options;
}

function makeContext(options) {
  return {
    ...options,
    platform: options.platform ?? process.platform,
    claudeHome: path.join(options.home, '.claude'),
    written: 0,
    skipped: 0,
    backups: 0,
    warnings: [],
    log: options.log ?? console.log,
  };
}

function report(ctx, status, message) {
  ctx.log(`[${status}] ${message}`);
  if (status === 'warn') ctx.warnings.push(message);
}

function readOptional(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertHash(bytes, expected, label) {
  if (typeof expected !== 'string' || sha256(bytes) !== expected.toLowerCase()) {
    throw new Error(`SHA256 mismatch: ${label} (corrupted checkout or failed copy)`);
  }
}

function resolveInside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.win32.isAbsolute(relative)) {
    throw new Error(`Expected a relative manifest path: ${relative}`);
  }
  const dest = path.resolve(root, relative.replaceAll('\\', '/'));
  const rel = path.relative(root, dest);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Manifest path escapes its root: ${relative}`);
  }
  return dest;
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function backupOnce(ctx, file, suffix = BACKUP_SUFFIX) {
  const backup = `${file}${suffix}`;
  if (!fs.existsSync(file) || fs.existsSync(backup)) return;
  if (!ctx.dryRun) {
    // COPYFILE_EXCL also protects backups if another installer races this one.
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === 'EEXIST') return;
      throw error;
    }
  }
  ctx.backups++;
  report(ctx, 'ok', `${ctx.dryRun ? 'Would back up' : 'Backed up'} ${file} -> ${backup}`);
}

function skip(ctx, label) {
  ctx.skipped++;
  report(ctx, 'skip', label);
}

function timestampedSuffix(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let suffix = `${BACKUP_SUFFIX}-${stamp}`;
  let index = 1;
  while (fs.existsSync(`${file}${suffix}`)) suffix = `${BACKUP_SUFFIX}-${stamp}-${index++}`;
  return suffix;
}

function backupLocalEdit(ctx, file, previous, dest, force = false) {
  const recorded = ctx.record?.files[dest];
  if (!force && recorded && sha256(previous) === recorded) return;
  const backup = `${file}${timestampedSuffix(file)}`;
  if (!ctx.dryRun) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  ctx.backups++;
  report(ctx, 'warn', `local edits saved to ${backup}${ctx.dryRun ? ' (planned only)' : ''}`);
}

class LocalDriftError extends Error {}

function verifyTarget(ctx, file, current) {
  const observed = ctx.prepared?.observed;
  if (!observed?.has(file)) return false;
  const previous = observed.get(file);
  if (previous === null ? current === null : current !== null && previous.equals(current)) return false;
  report(ctx, 'warn', `Local drift: ${file}`);
  if (!ctx.acceptLocalDrift) throw new LocalDriftError(`Target changed after preflight: ${file}`);
  return true;
}

function writtenPath(ctx, file) {
  (ctx.writtenPaths ??= new Set()).add(file);
}

function writeManaged(ctx, file, bytes, options = {}) {
  bytes = Buffer.from(bytes);
  const previous = readOptional(file);
  const changed = options.configIfAbsent ? false : verifyTarget(ctx, file, previous);
  if (previous && (options.configIfAbsent || previous.equals(bytes))) {
    skip(ctx, `${file}${options.configIfAbsent ? ' (config already exists)' : ' (identical)'}`);
    return false;
  }
  if (previous && (changed || ctx.prepared?.driftedFiles.includes(file))) {
    backupLocalEdit(ctx, file, previous, options.dest, true);
  } else if (previous && options.dest) backupLocalEdit(ctx, file, previous, options.dest);
  backupOnce(ctx, file, options.backupSuffix);
  if (!ctx.dryRun) {
    (options.writer ?? atomicWrite)(file, bytes);
    if (options.sha256) assertHash(fs.readFileSync(file), options.sha256, file);
  }
  ctx.written++;
  writtenPath(ctx, file);
  report(ctx, 'ok', `${ctx.dryRun ? 'Would write' : 'Installed'} ${file}`);
  return true;
}

function findExecutable(name, accept = () => true) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const names = path.extname(name) ? [name] : [name, ...extensions.map(ext => `${name}${ext.toLowerCase()}`)];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const candidate of names) {
      const file = path.resolve(dir.replace(/^"|"$/g, ''), candidate);
      try {
        fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(file).isFile() && accept(file)) return file;
      } catch {
        // Continue looking through PATH.
      }
    }
  }
  return null;
}

function findBash() {
  const isGitBash = file => !/\/windows\/system32\/bash\.exe$/i.test(file.replaceAll('\\', '/'));
  const candidates = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    findExecutable('bash', isGitBash),
  ];
  return candidates.find(file => file && fs.existsSync(file) && isGitBash(file)) ?? null;
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: CHECK_TIMEOUT, maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
}

function homeEnvironment(ctx) {
  return { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home };
}

function preflight(ctx) {
  report(ctx, 'ok', `Platform: ${ctx.platform}`);
  const minNode = ctx.platform === 'linux' ? 22 : 20;
  if (Number(process.versions.node.split('.')[0]) < minNode) throw new Error(`Node >= ${minNode} is required`);
  report(ctx, 'ok', `Node ${process.versions.node}`);
  if (ctx.platform === 'linux') {
    if (process.platform !== 'linux') {
      report(ctx, 'warn', `Linux PATH and Codex model checks skipped on ${process.platform}`);
      return;
    }
    const required = ['node', 'bash', 'curl', 'python3'];
    const found = Object.fromEntries(required.map(name => [name, findExecutable(name)]));
    for (const name of required) {
      report(ctx, found[name] ? 'ok' : 'warn', found[name] ? `${name}: ${found[name]}` : `${name} not found on PATH`);
    }
    ctx.bash = found.bash;
    const codex = findExecutable('codex');
    // The stock Linux CLI version the harness was last verified with (the panel reads it as the expected version).
    if (!codex) report(ctx, 'warn', 'codex not found on PATH; install @openai/codex@0.169.0');
    else {
      report(ctx, 'ok', `codex: ${codex}`);
      if (ctx.dryRun) report(ctx, 'warn', 'Codex model check skipped during dry-run to avoid CLI writes');
      else {
        // Check the model the shipped routing uses first for complex work, so the check follows the config.
        let model = 'gpt-6.2-sol';
        try {
          const routing = readJson(path.join(ctx.payload, 'claude', 'conveyor', 'orchestration.default.json'));
          model = routing.tiers?.complex?.find(entry => entry.provider === 'codex')?.model ?? model;
        } catch { /* keep the default name */ }
        const models = runCommand(codex, ['debug', 'models'], { env: homeEnvironment(ctx) });
        const available = models.status === 0 && new RegExp(`(?<![\\w.-])${model.replace(/[.]/g, '\\.')}(?![\\w.-])`).test(commandOutput(models));
        report(ctx, available ? 'ok' : 'warn', available ? `Codex model available: ${model}`
          : `codex debug models did not list ${model}`);
      }
    }
    if (required.some(name => !found[name])) throw new Error('Missing required Linux PATH executables');
    return;
  }
  ctx.bash = findBash();
  report(ctx, ctx.bash ? 'ok' : 'warn', ctx.bash ? `Git Bash: ${ctx.bash}` : 'Git Bash not found');
  const curl = findExecutable('curl');
  report(ctx, curl ? 'ok' : 'warn', curl ? `curl: ${curl}` : 'curl not found on PATH');
  // A constant shell command supports the codex.cmd shim on Windows without quoting user input.
  const codex = runCommand('codex --version', [], { shell: true, env: homeEnvironment(ctx) });
  const version = commandOutput(codex).replace(/\s+/g, ' ');
  const expected = codex.status === 0 && /\b0\.164\.0\b/.test(version);
  report(ctx, expected ? 'ok' : 'warn', codex.status === 0
    ? `Codex: ${version}${expected ? '' : ' (expected 0.164.0 for the custom build and plugin patches)'}`
    : 'codex --version failed; install Codex 0.164.0 (npm package @openai/codex, version 0.164.0)');
  const powershell = findExecutable('pwsh') ?? findExecutable('powershell');
  report(ctx, powershell ? 'ok' : 'warn', powershell ? `PowerShell: ${powershell}` : 'PowerShell not found');
  // Defender's real-time scan of the many small processes and files is a common CPU drain on this setup. The user
  // adds the exclusions themselves (a security setting); the script records what it added.
  const defenderRecord = path.join(process.env.ProgramData || 'C:\\ProgramData', 'LunaHarness', 'defender-exclusions.json');
  if (!fs.existsSync(defenderRecord)) {
    report(ctx, 'warn', 'Windows Defender: no harness exclusions yet. To stop real-time scanning from loading the CPU, '
      + 'run tools\\windows-defender-exclusions.ps1 in an elevated PowerShell (see INSTALL.md, step 8)');
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function externalInstalled(ctx, entry) {
  // The Claude list commands can write startup state. Read the registries directly, including on a dry-run.
  return entry.probe.every(({ path: relative, keys }) => {
    const file = resolveInside(ctx.home, relative);
    if (!keys) return fs.existsSync(file);
    const bytes = readOptional(file);
    if (!bytes) return false;
    let value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    for (const key of keys) value = value && Object.hasOwn(value, key) ? value[key] : undefined;
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

function displayArg(arg) {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return process.platform === 'win32' ? `'${arg.replaceAll("'", "''")}'` : `'${arg.replaceAll("'", "'\\''")}'`;
}

function externalExecutable(name) {
  const native = findExecutable(name, file => process.platform !== 'win32' || /\.(?:exe|com)$/i.test(file));
  if (native) return [native];
  if (process.platform !== 'win32' || name !== 'npx') return null;
  // npm ships npx as a .cmd shim on Windows. Launch the same entry point without shell interpolation.
  const shim = findExecutable('npx.cmd');
  const script = shim && path.join(path.dirname(shim), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return script && fs.existsSync(script) ? [process.execPath, script] : null;
}

function retainSettings(before, after) {
  const merged = { ...after, ...before };
  for (const [key, value] of Object.entries(before)) {
    const next = after[key];
    if (value && next && typeof value === 'object' && typeof next === 'object'
      && !Array.isArray(value) && !Array.isArray(next)) merged[key] = retainSettings(value, next);
  }
  return merged;
}

function preserveExternalSettings(file, before, kind) {
  const after = readOptional(file);
  if (after?.equals(before)) return;
  try {
    const previous = requireObject(JSON.parse(before.toString('utf8')), file);
    const updated = after ? requireObject(JSON.parse(after.toString('utf8').replace(/^\uFEFF/, '')), file) : {};
    const kept = retainSettings(previous, updated);
    if (kind === 'npm-installer') {
      const identities = new Set(hookIdentities(previous));
      for (const [event, entries] of Object.entries(updated.hooks ?? {})) {
        if (!Array.isArray(previous.hooks?.[event])) continue;
        for (const entry of entries) {
          const hooks = (entry.hooks ?? []).filter(hook => {
            const identity = hookIdentity(event, hook);
            if (!identity || identities.has(identity) || !/[\\/]gsd-/.test(hook.command)) return false;
            identities.add(identity);
            return true;
          });
          if (hooks.length) kept.hooks[event] = [...kept.hooks[event], { ...entry, hooks }];
        }
      }
    }
    if (stableJson(kept) === stableJson(previous)) atomicWrite(file, before);
    else if (stableJson(kept) !== stableJson(updated)) atomicWrite(file, `${JSON.stringify(kept, null, 2)}\n`);
  } catch (error) {
    atomicWrite(file, before);
    throw new Error(`Could not preserve settings after external setup: ${error.message}`, { cause: error });
  }
}

function configureExternals(ctx) {
  const entries = readJson(path.join(REPO_ROOT, 'external.json')).filter(entry => entry.platforms.includes(ctx.platform));
  // --owner-setup is explicit consent and wins over --check (the documented install is `--check --owner-setup`).
  const execute = ctx.ownerSetup && !ctx.dryRun;
  const env = { ...homeEnvironment(ctx), CLAUDE_CONFIG_DIR: ctx.claudeHome };
  delete env.CLAUDE_PLUGIN_DATA;
  const failures = [];
  for (const entry of entries) {
    const argv = substitutePlaceholders(entry.argv, ctx.claudeHome);
    const command = argv.map(displayArg).join(' ');
    const pending = command ? `${entry.id}: ${command}` : `${entry.id}: ${entry.purpose} ${entry.evidence}`;
    try {
      if (externalInstalled(ctx, entry)) continue;
      if (!execute) {
        report(ctx, 'pending', pending);
        continue;
      }
      if (entry.kind === 'manual') {
        report(ctx, 'warn', pending);
        continue;
      }
      const executable = externalExecutable(argv[0]);
      if (!executable) throw new Error(`${argv[0]} not found on PATH`);
      const [bin, ...prefix] = executable;
      const settings = path.join(ctx.claudeHome, 'settings.json');
      const before = fs.readFileSync(settings);
      const result = runCommand(bin, [...prefix, ...argv.slice(1)], { cwd: ctx.home, env });
      preserveExternalSettings(settings, before, entry.kind);
      if (result.status !== 0 || result.error) {
        throw new Error(commandOutput(result) || `exit ${result.status ?? result.signal}`);
      }
      if (!externalInstalled(ctx, entry)) throw new Error('installed-state probe still pending');
      report(ctx, 'ok', `Installed external entry ${entry.id}`);
    } catch (error) {
      report(ctx, 'warn', `${pending} — ${error.message}`);
      if (execute && entry.required) failures.push(entry);
    }
  }
  return failures.some(entry => {
    try {
      return !externalInstalled(ctx, entry);
    } catch {
      return true;
    }
  }) ? 4 : 0;
}

// Claude Code runs a plugin from its cache (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>), not from
// local-plugins: new files reach sessions only after the marketplace is refreshed and the plugin updated. Without this
// an upgrade from git leaves every session on the old Luna panel.
function refreshLocalPlugins(ctx) {
  const root = path.join(ctx.claudeHome, 'local-plugins') + path.sep;
  const changed = [...new Set([...(ctx.writtenPaths ?? [])].filter(file => file.startsWith(root))
    .map(file => file.slice(root.length).split(path.sep)[0]).filter(name => name && !name.startsWith('.')))];
  if (!changed.length) return;
  const installed = (() => {
    try { return readJson(path.join(ctx.claudeHome, 'plugins', 'installed_plugins.json'))?.plugins ?? {}; }
    catch { return {}; }
  })();
  const plugins = changed.filter(name => Object.hasOwn(installed, `${name}@luna-local`));
  if (!plugins.length) return;
  const manual = ['claude plugin marketplace update luna-local',
    ...plugins.map(name => `claude plugin update ${name}@luna-local`)].join(' && ');
  if (ctx.dryRun || supervisorDisabled(ctx)) {
    report(ctx, 'ok', `Would refresh the Claude plugin cache: ${manual}`);
    return;
  }
  const executable = externalExecutable('claude');
  if (!executable) {
    report(ctx, 'warn', `claude not found on PATH; to load the new plugin files run: ${manual}`);
    return;
  }
  const [bin, ...prefix] = executable;
  const env = { ...homeEnvironment(ctx), CLAUDE_CONFIG_DIR: ctx.claudeHome };
  delete env.CLAUDE_PLUGIN_DATA;
  const run = (args) => (ctx.pluginRunner ?? runCommand)(bin, [...prefix, ...args], { cwd: ctx.home, env, timeout: 120_000 });
  const marketplace = run(['plugin', 'marketplace', 'update', 'luna-local']);
  if (marketplace.status !== 0 || marketplace.error) {
    report(ctx, 'warn', `Could not refresh the luna-local marketplace (${commandOutput(marketplace) || 'failed'}); run: ${manual}`);
    return;
  }
  const updated = [];
  for (const name of plugins) {
    const result = run(['plugin', 'update', `${name}@luna-local`]);
    if (result.status === 0 && !result.error) updated.push(name);
    else report(ctx, 'warn', `Could not update ${name}@luna-local (${commandOutput(result) || 'failed'}); run: claude plugin update ${name}@luna-local`);
  }
  if (updated.length) report(ctx, 'ok', `Updated ${updated.join(', ')} in the Claude plugin cache; restart Claude sessions to load them`);
}

function installFiles(ctx, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported payload manifest');
  for (const file of manifest.files) {
    if (!['file', 'config-if-absent', 'binary'].includes(file.kind)) {
      throw new Error(`Unknown payload kind: ${file.kind}`);
    }
    if (file.executable !== undefined && typeof file.executable !== 'boolean') {
      throw new Error(`Invalid executable flag: ${file.src}`);
    }
    const source = resolveInside(ctx.payload, file.src);
    const bytes = fs.readFileSync(source);
    assertHash(bytes, file.sha256, source);
    const target = resolveInside(ctx.claudeHome, file.dest);
    const wrote = writeManaged(ctx, target, bytes, {
      dest: ctx.prepared ? file.dest : undefined,
      configIfAbsent: file.kind === 'config-if-absent',
      sha256: file.kind === 'binary' ? file.sha256 : undefined,
    });
    if (ctx.platform === 'linux' && process.platform !== 'win32' && file.executable && !ctx.dryRun) {
      const mode = fs.statSync(target).mode & 0o777;
      const executableMode = mode | ((mode & 0o444) >> 2) | 0o100;
      if (mode !== executableMode) {
        fs.chmodSync(target, executableMode);
        if (!wrote) {
          ctx.written++;
          writtenPath(ctx, target);
          report(ctx, 'ok', `Made executable ${target}`);
        }
      }
    }
  }
}

export function substitutePlaceholders(value, claudeHome) {
  const values = {
    '{{NODE}}': process.execPath.replaceAll('\\', '/'),
    '{{CLAUDE_HOME}}': claudeHome.replaceAll('\\', '/'),
    '{{CLAUDE_HOME_WIN}}': claudeHome.replaceAll('/', '\\'),
  };
  if (typeof value === 'string') {
    return value.replace(/\{\{(?:NODE|CLAUDE_HOME|CLAUDE_HOME_WIN)\}\}/g, token => values[token]);
  }
  if (Array.isArray(value)) return value.map(item => substitutePlaceholders(item, claudeHome));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, substitutePlaceholders(item, claudeHome),
    ]));
  }
  return value;
}

function settingsFragment(ctx, fragmentPath) {
  const fragment = substitutePlaceholders(readJson(fragmentPath), ctx.claudeHome);
  fragment.enabledPlugins ??= {};
  requireObject(fragment.enabledPlugins, 'enabledPlugins');
  fragment.enabledPlugins['pstack@luna-local'] = true;
  return fragment;
}

function hookIdentity(event, hook) {
  if (typeof hook.command !== 'string') return null;
  const tokens = [...hook.command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map(match => (match[1] ?? match[2] ?? match[3]).replaceAll('\\', '/'));
  for (let i = tokens.length - 1; i >= 0; i--) {
    const index = tokens[i].lastIndexOf('.claude/');
    if (index !== -1) return JSON.stringify([event, tokens[i].slice(index + 8), tokens[i + 1] ?? '']);
  }
  // Commands without a .claude script never collide with a managed script by accident.
  return JSON.stringify([event, hook.command]);
}

function replaceHook(entries, index, hookIndex, incoming, hook) {
  const previous = entries[index];
  const replacement = { ...previous.hooks[hookIndex], ...hook };
  if (!Object.hasOwn(hook, 'timeout')) delete replacement.timeout;
  const matcherChanged = previous.matcher !== incoming.matcher;
  if (matcherChanged && previous.hooks.length > 1) {
    const pieces = [];
    const before = previous.hooks.slice(0, hookIndex);
    const after = previous.hooks.slice(hookIndex + 1);
    if (before.length) pieces.push({ ...previous, hooks: before });
    const matched = { ...previous, hooks: [replacement] };
    if (Object.hasOwn(incoming, 'matcher')) matched.matcher = incoming.matcher;
    else delete matched.matcher;
    pieces.push(matched);
    if (after.length) pieces.push({ ...previous, hooks: after });
    entries.splice(index, 1, ...pieces);
  } else {
    previous.hooks[hookIndex] = replacement;
    if (Object.hasOwn(incoming, 'matcher')) previous.matcher = incoming.matcher;
    else delete previous.matcher;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function mergeSettings(settings, fragment) {
  requireObject(settings, 'settings.json');
  requireObject(fragment, 'settings fragment');
  if (fragment.hooks) {
    settings.hooks ??= {};
    requireObject(settings.hooks, 'settings.hooks');
    for (const [event, incomingEntries] of Object.entries(fragment.hooks)) {
      const entries = settings.hooks[event] ??= [];
      if (!Array.isArray(entries) || !Array.isArray(incomingEntries)) {
        throw new Error(`Hook event ${event} must contain an array`);
      }
      for (const incoming of incomingEntries) {
        if (!Array.isArray(incoming.hooks)) throw new Error(`Missing hooks array under ${event}`);
        for (const hook of incoming.hooks) {
          const identity = hookIdentity(event, hook);
          let found = false;
          for (let index = 0; index < entries.length && !found; index++) {
            const hookIndex = (entries[index].hooks ?? []).findIndex(item => hookIdentity(event, item) === identity);
            if (hookIndex !== -1) {
              replaceHook(entries, index, hookIndex, incoming, hook);
              found = true;
            }
          }
          if (!found) entries.push({ ...incoming, hooks: [{ ...hook }] });
        }
      }
    }
  }
  for (const key of ['extraKnownMarketplaces', 'enabledPlugins']) {
    if (fragment[key]) {
      requireObject(fragment[key], key);
      settings[key] = { ...requireObject(settings[key] ?? {}, key), ...fragment[key] };
    }
  }
  return settings;
}

function installSettings(ctx, fragmentPath, writer = atomicWrite) {
  const file = path.join(ctx.claudeHome, 'settings.json');
  const previous = readOptional(file);
  const changed = verifyTarget(ctx, file, previous);
  let attempted = false;
  try {
    const settings = previous ? JSON.parse(previous.toString('utf8').replace(/^\uFEFF/, '')) : {};
    const fragment = ctx.prepared?.fragment ?? settingsFragment(ctx, fragmentPath);
    removeHooks(ctx, settings, ctx.droppedHooks ?? []);
    const next = `${JSON.stringify(mergeSettings(settings, fragment), null, 2)}\n`;
    if (previous?.equals(Buffer.from(next))) {
      skip(ctx, 'settings.json already merged');
      return;
    }
    if (previous && (changed || ctx.prepared?.driftedFiles.includes(file))) {
      backupLocalEdit(ctx, file, previous, undefined, true);
    }
    backupOnce(ctx, file);
    if (!ctx.dryRun) {
      attempted = true;
      writer(file, next);
      requireObject(readJson(file), 'written settings.json');
      if (!fs.readFileSync(file).equals(Buffer.from(next))) throw new Error('Settings write verification failed');
    }
    ctx.written++;
    writtenPath(ctx, file);
    report(ctx, 'ok', `${ctx.dryRun ? 'Would merge' : 'Merged'} settings.json`);
  } catch (error) {
    if (attempted) {
      // The permanent backup may predate user edits. Restore this invocation's exact original bytes.
      if (previous) atomicWrite(file, previous);
      else fs.rmSync(file, { force: true });
    }
    throw new Error(`settings.json merge failed; original settings preserved: ${error.message}`, { cause: error });
  }
}

function normalizedText(text) {
  return text.replaceAll('\r\n', '\n').replace(/[\t ]+$/gm, '').trimEnd();
}

function markerRange(text) {
  const begins = [...text.matchAll(/<!-- luna-harness:begin -->/g)];
  const ends = [...text.matchAll(/<!-- luna-harness:end -->/g)];
  if (!begins.length && !ends.length) return null;
  if (begins.length !== 1 || ends.length !== 1 || begins[0].index >= ends[0].index) {
    throw new Error('CLAUDE.md has ambiguous or incomplete luna-harness markers; repair them before installing');
  }
  return { start: begins[0].index, end: ends[0].index + END.length };
}

function managedBlock(bytes) {
  const text = bytes?.toString('utf8') ?? '';
  const range = markerRange(text);
  return range ? text.slice(range.start, range.end) : null;
}

function claudeBlock(payload) {
  return `${BEGIN}\n${payload.toString('utf8').replaceAll('\r\n', '\n').trimEnd()}\n${END}`;
}

function installClaudeMd(ctx, source) {
  const file = path.join(ctx.claudeHome, 'CLAUDE.md');
  const payload = fs.readFileSync(source, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  const block = claudeBlock(payload);
  const previous = readOptional(file);
  verifyTarget(ctx, file, previous);
  if (!previous) {
    writeManaged(ctx, file, `${block}\n`);
    return;
  }
  const text = previous.toString('utf8');
  const range = markerRange(text);
  if (range) {
    writeManaged(ctx, file, `${text.slice(0, range.start)}${block}${text.slice(range.end)}`);
  } else if (normalizedText(text) === normalizedText(payload)) {
    skip(ctx, 'CLAUDE.md already matches');
  } else if (previousPayloadMatches(ctx, source, text)) {
    // An unmarked file that is exactly the harness text of the previous install was never edited by hand: replace it
    // (now with markers, so later upgrades replace only the block) instead of appending a second copy.
    writeManaged(ctx, file, `${block}\n`);
    report(ctx, 'ok', 'CLAUDE.md was the previous harness version, unedited: replaced');
  } else {
    writeManaged(ctx, file, `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}\n`);
    report(ctx, 'warn', 'CLAUDE.md block appended; merge duplicates in your existing instructions if needed');
  }
}

function previousPayloadMatches(ctx, source, text) {
  const commit = ctx.record?.repoCommit;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return false;
  const relative = path.relative(REPO_ROOT, source).split(path.sep).join('/');
  if (!relative || relative.startsWith('..')) return false;
  const result = runCommand('git', ['show', `${commit}:${relative}`], { cwd: REPO_ROOT });
  return result.status === 0 && normalizedText(result.stdout) === normalizedText(text);
}

function installEnv(ctx) {
  const file = path.join(ctx.claudeHome, 'luna-harness.env');
  const previous = readOptional(file)?.toString('utf8') ?? '';
  const pattern = /^LUNA_CUSTOM_CODEX_ROOT=(.*)\r?$/gm;
  const matches = [...previous.matchAll(pattern)];
  const existing = matches[0]?.[1].replace(/\r$/, '').trim();
  const root = ctx.codexBuildRoot ?? (existing || path.join(ctx.home, 'codex-build'));
  if (/[\r\n]/.test(root)) throw new Error('Custom Codex root cannot contain a newline');
  ctx.customRoot = root;
  let replaced = false;
  const next = matches.length ? previous.replace(pattern, () => {
    if (replaced) return '';
    replaced = true;
    return `LUNA_CUSTOM_CODEX_ROOT=${root}`;
  }) : `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}LUNA_CUSTOM_CODEX_ROOT=${root}\n`;
  ctx.collectorNode = process.execPath;
  const previousNode = /^LUNA_NODE=([^\r\n]*)/m.exec(previous)?.[1] ?? null;
  ctx.previousCollectorNode = previousNode === ctx.record?.collectorNode
    ? ctx.record.previousCollectorNode : previousNode;
  writeManaged(ctx, file, collectorNodeLine(next, ctx.collectorNode));
}

function collectorNodeLine(text, value) {
  const key = /^LUNA_NODE=[^\r\n]*(?:\r?\n|$)/gm;
  const line = value === null ? '' : `LUNA_NODE=${value}\n`;
  if (key.test(text)) {
    let entry = line;
    return text.replace(key, () => {
      const current = entry;
      entry = '';
      return current;
    });
  }
  return line ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}` : text;
}

function collectorUnit(ctx) {
  return path.join(ctx.home, '.config', 'systemd', 'user', COLLECTOR_UNIT);
}

function collectorUnitBytes(ctx) {
  const escape = (value) => JSON.stringify(value.replaceAll('%', '%%'));
  const node = escape(process.execPath);
  const script = escape(path.join(ctx.claudeHome, COLLECTOR_SCRIPT).replaceAll('$', '$$'));
  return Buffer.from([
    '[Unit]', 'Description=Luna shared collector', 'StartLimitIntervalSec=300', 'StartLimitBurst=5', '',
    '[Service]', `ExecStart=${node} ${script} run`,
    'Restart=always', 'RestartSec=10', 'RestartPreventExitStatus=3', 'Nice=10', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n'));
}

function supervisorDisabled(ctx) {
  if (process.env.LUNA_INSTALL_NO_SUPERVISOR === '1' || ctx.platform !== process.platform) return true;
  try {
    const target = path.resolve(ctx.home), real = path.resolve(os.userInfo().homedir);
    return ctx.platform === 'win32' ? target.toLowerCase() !== real.toLowerCase() : target !== real;
  } catch { return true; }
}

function supervisorCommand(ctx, command, args, { timeout = 30_000, runDir } = {}) {
  const env = homeEnvironment(ctx);
  delete env.CONVEYOR_PLATFORM;
  if (runDir) env.LUNA_RUN_DIR = runDir;
  return (ctx.supervisorRunner ?? runCommand)(command, args, { env, timeout });
}

function collectorWarning(ctx, detail) {
  const manual = ctx.platform === 'win32'
    ? 'node "%USERPROFILE%\\.claude\\scripts\\luna-collector.mjs" run'
    : 'node ~/.claude/scripts/luna-collector.mjs run &';
  report(ctx, 'warn', `${detail}. Manual start: ${manual}`);
}

function systemctl(ctx, ...args) {
  const result = supervisorCommand(ctx, 'systemctl', ['--user', ...args]);
  if (result.status === 0) return true;
  collectorWarning(ctx, `systemctl --user ${args.join(' ')} failed: ${commandOutput(result)}`);
  return false;
}

function collectorLock(runDir) {
  return path.join(runDir, 'collector', 'collector.lock');
}

function collectorRunDirs(ctx) {
  return [...new Set([path.join(ctx.claudeHome, 'luna-run'),
    ...(process.env.LUNA_RUN_DIR ? [path.resolve(process.env.LUNA_RUN_DIR)] : [])])];
}

function collectorOwner(lock) {
  const bytes = readOptional(lock);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}

function collectorCommand(ctx, action, options) {
  return supervisorCommand(ctx, process.execPath, [path.join(ctx.claudeHome, COLLECTOR_SCRIPT), action], options);
}

function waitForCollector(check, timeout) {
  const deadline = performance.now() + timeout;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  do {
    if (check(Math.max(1, Math.floor(deadline - performance.now())))) return true;
    const remaining = deadline - performance.now();
    if (remaining > 0) Atomics.wait(sleeper, 0, 0, Math.min(250, remaining));
  } while (performance.now() < deadline);
  return false;
}

function collectorPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function stopInstalledCollector(ctx, { legacy = false } = {}) {
  const [local, configured] = collectorRunDirs(ctx);
  const script = path.join(ctx.claudeHome, COLLECTOR_SCRIPT);
  const dirs = legacy && configured ? [configured, local] : [local];
  for (const runDir of dirs) {
    const lock = collectorLock(runDir);
    const owner = collectorOwner(lock);
    if (legacy && !collectorPidAlive(owner?.pid)) continue;
    if (!fs.existsSync(script)) {
      if (!fs.existsSync(lock)) continue;
      collectorWarning(ctx, `Cannot stop the collector because ${script} is missing`);
      return false;
    }
    let stopRunDir = legacy ? runDir : undefined;
    if (legacy && runDir === local && configured && owner?.instance &&
        collectorOwner(path.join(configured, 'collector', 'discovery.json'))?.instance === owner.instance) {
      stopRunDir = configured;
    }
    const result = collectorCommand(ctx, 'stop', { runDir: stopRunDir });
    if (result.status !== 0 || !waitForCollector(() => !fs.existsSync(lock) && !collectorPidAlive(owner?.pid), 10_000)) {
      collectorWarning(ctx, `The previous collector did not stop: ${commandOutput(result)}`);
      return false;
    }
  }
  return true;
}

function collectorRunCommand(ctx) {
  return `wscript.exe //B //NoLogo "${path.join(ctx.claudeHome, COLLECTOR_SUPERVISOR)}"`;
}

function readCollectorRunValue(ctx) {
  const result = supervisorCommand(ctx, 'reg.exe', ['query', COLLECTOR_RUN_KEY]);
  if (result.status === 0) {
    // reg.exe indents each column with four spaces. Preserve whitespace inside the command.
    const line = (result.stdout ?? '').split(/\r?\n/).find((line) => /^\s*LunaCollector(?:\s|$)/i.test(line));
    if (!line) return { ok: true, value: null };
    const value = /^ {4}LunaCollector {4}(REG_\w+) {4}(.*)$/i.exec(line);
    if (!value) return { ok: false, reason: 'unrecognized LunaCollector registry output' };
    return { ok: true, value: { type: value[1], command: value[2] } };
  }
  const parent = supervisorCommand(ctx, 'reg.exe', ['query', path.win32.dirname(COLLECTOR_RUN_KEY)]);
  const key = COLLECTOR_RUN_KEY.replace(/^HKCU/i, 'HKEY_CURRENT_USER');
  const hasRunKey = (parent.stdout ?? '').split(/\r?\n/).some((line) => line.trim().toLowerCase() === key.toLowerCase());
  if (parent.status === 0 && !hasRunKey) return { ok: true, value: null };
  return { ok: false, reason: commandOutput(result) };
}

function matchesCollectorRunValue(ctx, value) {
  return value?.type === 'REG_SZ' && value.command === collectorRunCommand(ctx);
}

function isLunaRunValue(value) {
  if (value?.type !== 'REG_SZ') return false;
  const script = /^wscript\.exe \/\/B \/\/NoLogo "([^"\r\n]+)"$/.exec(value.command)?.[1];
  return Boolean(script && path.win32.isAbsolute(script) && script.endsWith(
    `\\.claude\\${COLLECTOR_SUPERVISOR.replaceAll('/', '\\')}`));
}

function checkCollectorSupervisor(ctx) {
  if (ctx.platform === 'linux') {
    if (readOptional(collectorUnit(ctx))?.equals(collectorUnitBytes(ctx))) return 0;
    report(ctx, 'warn', `Collector unit drift: ${collectorUnit(ctx)} is missing or differs`);
    return 1;
  }
  if (supervisorDisabled(ctx)) return 0;
  const { ok, value } = readCollectorRunValue(ctx);
  if (ok && matchesCollectorRunValue(ctx, value)) return 0;
  report(ctx, 'warn', 'Collector logon registration drift: HKCU Run value LunaCollector is missing, unreadable or differs');
  return 1;
}

function installCollectorSupervisor(ctx, changed, previousInstance) {
  if (ctx.dryRun) {
    const supervisor = ctx.platform === 'linux' ? COLLECTOR_UNIT : 'HKCU Run value LunaCollector';
    report(ctx, 'ok', `Would enable and start ${supervisor}`);
    return false;
  }
  if (supervisorDisabled(ctx)) return false;
  if (ctx.platform === 'linux') {
    if (!systemctl(ctx, 'daemon-reload')) return false;
    if (!changed) return systemctl(ctx, 'enable', '--now', COLLECTOR_UNIT);
    if (previousInstance && !stopInstalledCollector(ctx)) return false;
    if (!systemctl(ctx, 'enable', COLLECTOR_UNIT) || !systemctl(ctx, 'restart', COLLECTOR_UNIT)) return false;
  } else {
    if (!findExecutable('wscript.exe')) {
      collectorWarning(ctx, 'wscript.exe unavailable');
      return false;
    }
    const { ok, value, reason } = readCollectorRunValue(ctx);
    if (!ok || value && !matchesCollectorRunValue(ctx, value) && !isLunaRunValue(value)) {
      collectorWarning(ctx, ok ? 'HKCU Run value LunaCollector differs and was kept' : `Could not read LunaCollector: ${reason}`);
      return false;
    }
    if (!matchesCollectorRunValue(ctx, value)) {
      const result = supervisorCommand(ctx, 'reg.exe', ['add', COLLECTOR_RUN_KEY, '/v', 'LunaCollector',
        '/t', 'REG_SZ', '/d', collectorRunCommand(ctx), ...(value ? ['/f'] : [])]);
      if (result.status !== 0) {
        collectorWarning(ctx, `Could not register the collector at logon: ${commandOutput(result)}`);
        return false;
      }
    }
    if (changed && !stopInstalledCollector(ctx)) return false;
    const start = collectorCommand(ctx, 'start');
    if (start.status !== 0) {
      collectorWarning(ctx, `Could not start the collector supervisor: ${commandOutput(start)}`);
      return false;
    }
  }
  if (!changed) return true;
  const running = waitForCollector((timeout) => {
    const result = collectorCommand(ctx, 'status', { timeout });
    if (result.status !== 0) return false;
    try {
      const status = JSON.parse(result.stdout);
      return status.running === true && typeof status.discovery?.instance === 'string' &&
        status.discovery.instance !== previousInstance;
    } catch { return false; }
  }, 15_000);
  if (running) report(ctx, 'ok', 'Collector restarted and passed its health check');
  else collectorWarning(ctx, 'The replacement collector did not pass its health check within 15 seconds');
  return running;
}

function uninstallCollectorSupervisor(ctx) {
  const disabled = supervisorDisabled(ctx) || ctx.dryRun;
  if (!disabled) {
    if (ctx.platform === 'win32' && ctx.record.collectorNode) {
      const { ok, value, reason } = readCollectorRunValue(ctx);
      if (!ok) throw new Error(`Could not read HKCU Run value LunaCollector: ${reason}`);
      if (matchesCollectorRunValue(ctx, value)) {
        const result = supervisorCommand(ctx, 'reg.exe', ['delete', COLLECTOR_RUN_KEY, '/v', 'LunaCollector', '/f']);
        if (result.status !== 0) throw new Error(`Could not delete HKCU Run value LunaCollector: ${commandOutput(result)}`);
      }
    }
    if (ctx.platform === 'linux' && ctx.record.collectorUnitSha256 && fs.existsSync(collectorUnit(ctx)) &&
        !systemctl(ctx, 'disable', '--now', COLLECTOR_UNIT)) throw new Error('Could not disable the collector unit');
    const legacy = !ctx.record.collectorUnitSha256 && !ctx.record.collectorNode;
    if (!stopInstalledCollector(ctx, { legacy })) throw new Error('Could not stop the collector; install record retained');
  }
  if (ctx.platform === 'linux' && ctx.record.collectorUnitSha256) {
    if (disabled) report(ctx, 'ok', `Would disable and stop ${COLLECTOR_UNIT}`);
    const file = collectorUnit(ctx);
    const bytes = readOptional(file);
    if (bytes && sha256(bytes) === ctx.record.collectorUnitSha256) removeFile(ctx, file);
    else if (bytes) report(ctx, 'warn', `Kept locally edited file: ${file}`);
    if (!disabled) systemctl(ctx, 'daemon-reload');
  }
  if (ctx.platform === 'win32' && ctx.record.collectorNode) {
    if (disabled) report(ctx, 'ok', 'Would remove HKCU Run value LunaCollector and stop the collector');
    if (!ctx.record.createdEnv) {
      const file = path.join(ctx.claudeHome, 'luna-harness.env');
      const current = readOptional(file)?.toString('utf8');
      if (current && /^LUNA_NODE=([^\r\n]*)/m.exec(current)?.[1] === ctx.record.collectorNode) {
        writeManaged(ctx, file, collectorNodeLine(current, ctx.record.previousCollectorNode ?? null));
      }
    }
  }
}

function installSentinel(ctx) {
  const file = path.join(ctx.claudeHome, 'codex-gate-runner-off');
  if (fs.existsSync(file)) skip(ctx, 'codex-gate-runner-off already exists');
  else writeManaged(ctx, file, '');
  report(ctx, 'ok', 'Plugin Stop hook owns the review gate; sentinel prevents duplicate gates and orphaned brokers');
}

function patchPlugins(ctx, manifestPath) {
  if (ctx.noPluginPatch) {
    skip(ctx, 'Plugin patches disabled by --no-plugin-patch');
    return;
  }
  const manifest = ctx.prepared?.patches ?? loadPatchSet(manifestPath);
  const roots = manifest.roots.flatMap(relative => {
    const expanded = expandRoots(ctx.claudeHome, [relative]);
    if (!expanded.some(root => fs.existsSync(root)) && !ctx.pluginMissingWarned) {
      ctx.pluginMissingWarned = true;
      report(ctx, 'warn', 'codex@openai-codex not installed yet; re-run install.mjs after installing it to apply patches');
    }
    return expanded;
  });
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const plan = planRoot(root, manifest.files);
    for (const result of plan.entries) {
      const { file, target } = result;
      if (result.status === 'unknown') {
        report(ctx, 'warn', `${target}: plugin version differs — apply manually,`
          + ' see payload/codex-plugin-patches/README.md');
      } else if (!plan.canPatch) {
        continue;
      } else if (result.status === 'patched') {
        skip(ctx, `${target} already patched`);
      } else if (result.status === 'patchable') {
        verifyTarget(ctx, target, readOptional(target));
        const backup = `${target}.orig-luna-harness`;
        const previous = readOptional(backup);
        if (previous && !previous.equals(result.bytes)) {
          if (!ctx.dryRun) atomicWrite(backup, result.bytes);
          ctx.backups++;
          report(ctx, 'ok', `${ctx.dryRun ? 'Would refresh backup:' : 'refreshed backup:'} ${target}`);
        }
        writeManaged(ctx, target, result.patchedBytes, {
          backupSuffix: '.orig-luna-harness', sha256: sha256(result.patchedBytes),
        });
      }
    }
    if (plan.incomplete) {
      report(ctx, 'warn', `${root}: left unpatched, missing plugin files: ${plan.missing.join(', ')}`);
    }
    if (plan.unknown) report(ctx, 'warn', `${root}: left unpatched, unknown plugin files`);
  }
}

function checkCustomCodex(ctx) {
  const exe = path.join(ctx.customRoot, 'dist', 'bin', 'codex.exe');
  if (!fs.existsSync(exe)) {
    report(ctx, 'warn', 'custom Codex not built yet — follow codex-build/BUILD.md (stock codex still works)');
    return;
  }
  const result = runCommand(exe, ['--version'], { env: homeEnvironment(ctx) });
  report(ctx, result.status === 0 ? 'ok' : 'warn', `Custom Codex: ${exe}: ${commandOutput(result)}`);
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file) : entry.isFile() ? [file] : [];
  });
}

function runChecks(ctx, runner = runCommand) {
  const scripts = path.join(ctx.claudeHome, 'scripts');
  const checks = [
    ['heavy-gate.mjs', '--self-test'],
    ['luna-reap-brokers.mjs', '--self-test'],
    ['luna-overview.mjs', '--self-test'],
    ['luna-clean.mjs', '--self-test'],
    ['luna-daemon.mjs', '--self-test-unit'],
  ].map(([file, flag]) => ({ label: `${file} ${flag}`, file: path.join(scripts, file), flag }));
  const learning = path.join(scripts, 'learning', 'test');
  checks.push({ label: 'learning/test/ (node --test)', file: learning, learning: true });
  const shellFiles = walkFiles(scripts).filter(file => file.endsWith('.sh'));
  if (!shellFiles.length) skip(ctx, 'bash -n scripts/**/*.sh (no shell scripts)');
  for (const file of shellFiles) {
    checks.push({ label: `bash -n ${path.relative(ctx.claudeHome, file)}`, file, bash: true });
  }
  const hooks = walkFiles(path.join(ctx.claudeHome, 'hooks')).filter(file => /\.(?:mjs|cjs|js)$/.test(file));
  if (!hooks.length) skip(ctx, 'node --check hooks (no JavaScript hooks)');
  for (const file of hooks) {
    checks.push({ label: `node --check ${path.relative(ctx.claudeHome, file)}`, file, syntax: true });
  }
  const env = homeEnvironment(ctx);
  let failed = 0;
  let passed = 0;
  ctx.log('Checks: RESULT | command (300 s timeout each)');
  for (const check of checks) {
    if (!fs.existsSync(check.file)) {
      skip(ctx, `${check.label} (missing)`);
      continue;
    }
    if (check.bash && !ctx.bash) {
      failed++;
      report(ctx, 'FAIL', `FAIL | ${check.label}: ${ctx.platform === 'linux' ? 'bash' : 'Git Bash'} unavailable`);
      continue;
    }
    let command = process.execPath;
    let args = [check.file, check.flag];
    if (check.bash) {
      command = ctx.bash;
      args = ['-n', check.file.replaceAll('\\', '/')];
    } else if (check.learning) {
      // Node 22 on Windows does not expand a directory argument for --test: pass the test files themselves.
      const tests = walkFiles(check.file).filter(file => file.endsWith('.test.mjs')).sort();
      args = ['--test', ...tests];
    }
    else if (check.syntax) args = ['--check', check.file];
    const result = runner(command, args, { env, cwd: ctx.claudeHome });
    const success = result.status === 0 && !result.error;
    if (success) passed++;
    else failed++;
    report(ctx, success ? 'ok' : 'FAIL', `${success ? 'PASS' : 'FAIL'} | ${check.label}`);
    if (!success) ctx.log(commandOutput(result) || `Process ended with signal ${result.signal}`);
  }
  ctx.log(`Checks: ${passed} PASS, ${failed} FAIL`);
  return failed ? 1 : 0;
}

function printSummary(ctx) {
  const action = ctx.dryRun ? 'would be written' : 'written';
  ctx.log(`Summary: ${ctx.written} files ${action}; ${ctx.skipped} skipped; ${ctx.backups} backups created`
    + (ctx.dryRun ? ' (planned only).' : '.'));
  ctx.log(`Warnings: ${ctx.warnings.length}`);
  for (const warning of ctx.warnings) ctx.log(`  - ${warning}`);
  if (!ctx.uninstall && ctx.platform === 'win32') {
    ctx.log('Next steps: build custom Codex using codex-build/BUILD.md if needed.');
  }
}

function hookIdentities(fragment) {
  return [...new Set(Object.entries(fragment.hooks ?? {}).flatMap(([event, entries]) =>
    entries.flatMap(entry => entry.hooks.map(hook => hookIdentity(event, hook))).filter(Boolean)))];
}

function removeHooks(ctx, settings, identities) {
  const removed = new Set(identities);
  if (!settings.hooks || !removed.size) return;
  let changed = false;
  requireObject(settings.hooks, 'settings.hooks');
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) throw new Error(`Hook event ${event} must contain an array`);
    settings.hooks[event] = entries.flatMap(entry => {
      if (!Array.isArray(entry.hooks)) throw new Error(`Missing hooks array under ${event}`);
      const hooks = entry.hooks.filter(hook => {
        const identity = hookIdentity(event, hook);
        if (!removed.has(identity)) return true;
        changed = true;
        if (ctx) report(ctx, 'ok', `${ctx.dryRun ? 'Would remove' : 'Removed'} hook ${identity}`);
        return false;
      });
      if (hooks.length === entry.hooks.length) return [entry];
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
    if (entries.length && !settings.hooks[event].length) delete settings.hooks[event];
  }
  if (changed && !Object.keys(settings.hooks).length) delete settings.hooks;
}

function readRecord(ctx, required = false) {
  const file = path.join(ctx.claudeHome, RECORD);
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Cannot uninstall: install record not found: ${file}`);
    return null;
  }
  const record = requireObject(readJson(file), 'install record');
  if (record.v !== 1 || !Array.isArray(record.hooks) || record.hooks.some(item => typeof item !== 'string')) {
    throw new Error('Invalid install record');
  }
  requireObject(record.files, 'install record files');
  for (const [dest, hash] of Object.entries(record.files)) {
    resolveInside(ctx.claudeHome, dest);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid recorded SHA256');
  }
  for (const target of record.pluginFiles ?? []) resolveInside(ctx.claudeHome, target);
  return record;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Only hash portions the merge owns. Foreign hooks, settings, and JSON formatting remain the user's.
function managedSettings(settings, fragment, identities) {
  const managed = {};
  for (const identity of identities) {
    const matches = [];
    for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
      for (const entry of entries) for (const hook of entry.hooks ?? []) {
        if (hookIdentity(event, hook) === identity) matches.push({ matcher: entry.matcher ?? null, hook });
      }
    }
    if (matches.length) managed[`hook:${identity}`] = sha256(stableJson(matches));
  }
  for (const key of ['extraKnownMarketplaces', 'enabledPlugins']) {
    for (const name of Object.keys(fragment[key] ?? {})) {
      if (Object.hasOwn(settings[key] ?? {}, name)) {
        managed[`${key}:${name}`] = sha256(stableJson(settings[key][name]));
      }
    }
  }
  return managed;
}

function prepareInstall(ctx, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported payload manifest');
  const existingFiles = new Set();
  const destinations = new Set();
  const driftedFiles = [];
  const observed = new Map();
  const observe = target => {
    if (!observed.has(target)) observed.set(target, readOptional(target));
    return observed.get(target);
  };
  for (const file of manifest.files) {
    if (!['file', 'config-if-absent', 'binary'].includes(file.kind)) {
      throw new Error(`Unknown payload kind: ${file.kind}`);
    }
    if (file.executable !== undefined && typeof file.executable !== 'boolean') {
      throw new Error(`Invalid executable flag: ${file.src}`);
    }
    const source = resolveInside(ctx.payload, file.src);
    const bytes = fs.readFileSync(source);
    assertHash(bytes, file.sha256, source);
    const target = resolveInside(ctx.claudeHome, file.dest);
    if (destinations.has(file.dest)) throw new Error(`Duplicate payload destination: ${file.dest}`);
    destinations.add(file.dest);
    const previous = observe(target);
    if (previous) {
      existingFiles.add(file.dest);
      if (file.kind !== 'config-if-absent' && !previous.equals(bytes)
        && sha256(previous) !== ctx.record?.files[file.dest]) {
        driftedFiles.push(target);
      }
    }
  }
  const settingsPath = path.join(ctx.claudeHome, 'settings.json');
  const settingsBytes = observe(settingsPath);
  const settings = settingsBytes
    ? requireObject(JSON.parse(settingsBytes.toString('utf8').replace(/^\uFEFF/, '')), 'settings.json') : {};
  const settingsSource = resolveInside(ctx.payload, manifest.settings);
  if (ctx.platform === 'linux' || Object.hasOwn(manifest, 'settingsSha256')) {
    assertHash(fs.readFileSync(settingsSource), manifest.settingsSha256, settingsSource);
  }
  const fragment = settingsFragment(ctx, settingsSource);
  const hooks = hookIdentities(mergeSettings({}, structuredClone(fragment)));
  const droppedHooks = (ctx.record?.hooks ?? []).filter(identity => !hooks.includes(identity));
  const identities = [...hooks, ...droppedHooks];
  const currentSettings = managedSettings(settings, fragment, identities);
  removeHooks(null, settings, droppedHooks);
  mergeSettings(settings, structuredClone(fragment));
  const nextSettings = managedSettings(settings, fragment, identities);
  const settingsMeta = ctx.record?.restoration?.['settings.json'];
  const cleanSettings = settingsBytes && sha256(settingsBytes) === settingsMeta?.installedSha256;
  const recordedSettings = settingsMeta?.managed ?? (cleanSettings ? currentSettings : {});
  const settingsKeys = new Set([...Object.keys(currentSettings), ...Object.keys(recordedSettings)]);
  if ([...settingsKeys].some(key => currentSettings[key] !== nextSettings[key]
    && currentSettings[key] !== recordedSettings[key])) driftedFiles.push(settingsPath);
  const mdPath = path.join(ctx.claudeHome, 'CLAUDE.md');
  const md = observe(mdPath);
  const currentBlock = managedBlock(md);
  const mdSource = resolveInside(ctx.payload, manifest.claudeMd);
  const mdBytes = fs.readFileSync(mdSource);
  if (ctx.platform === 'linux' || Object.hasOwn(manifest, 'claudeMdSha256')) {
    assertHash(mdBytes, manifest.claudeMdSha256, mdSource);
  }
  const mdMeta = ctx.record?.restoration?.['CLAUDE.md'];
  const cleanMd = md && sha256(md) === mdMeta?.installedSha256;
  const recordedBlock = mdMeta?.managedSha256 ?? (cleanMd && currentBlock !== null ? sha256(currentBlock) : null);
  if (currentBlock !== null && currentBlock !== claudeBlock(mdBytes) && sha256(currentBlock) !== recordedBlock) {
    driftedFiles.push(mdPath);
  }
  let patches = null;
  if (ctx.platform === 'win32') {
    patches = loadPatchSet(resolveInside(ctx.payload, manifest.pluginPatches));
    for (const root of expandRoots(ctx.claudeHome, patches.roots)) {
      for (const file of patches.files) observe(resolveInside(root, file.rel));
    }
  }
  if (ctx.platform === 'win32' && ctx.codexBuildRoot && /[\r\n]/.test(ctx.codexBuildRoot)) {
    throw new Error('Custom Codex root cannot contain a newline');
  }
  for (const dest of Object.keys(ctx.record?.files ?? {})) observe(resolveInside(ctx.claudeHome, dest));
  for (const name of [RECORD, 'luna-harness.env', 'codex-gate-runner-off']) observe(path.join(ctx.claudeHome, name));
  if (ctx.platform === 'linux') {
    const file = collectorUnit(ctx);
    const previous = observe(file);
    if (previous && !previous.equals(collectorUnitBytes(ctx)) && sha256(previous) !== ctx.record?.collectorUnitSha256) {
      driftedFiles.push(file);
    }
  }
  ctx.droppedHooks = droppedHooks;
  ctx.prepared = { fragment, hooks, patches, existingFiles, driftedFiles, observed };
}

function protectedData(dest) {
  return /^(?:luna-run|learning)(?:\/|$)/.test(dest.replaceAll('\\', '/'))
    || /\.(?:bak|orig)-luna-harness/.test(dest);
}

function removeFile(ctx, file) {
  if (!fs.existsSync(file)) return;
  if (!ctx.dryRun) fs.unlinkSync(file);
  ctx.written++;
  writtenPath(ctx, file);
  report(ctx, 'ok', `${ctx.dryRun ? 'Would remove' : 'Removed'} ${file}`);
}

function removeRecordedFile(ctx, dest, hash) {
  const file = resolveInside(ctx.claudeHome, dest);
  const bytes = readOptional(file);
  if (!bytes) return;
  if (protectedData(dest)) {
    report(ctx, 'warn', `Kept protected data or backup: ${file}`);
  } else if (sha256(bytes) !== hash) {
    report(ctx, 'warn', `Kept locally edited file: ${file}`);
  } else {
    removeFile(ctx, file);
  }
}

function pruneUpgrade(ctx, manifest) {
  const current = new Set(manifest.files.map(file => file.dest));
  for (const [dest, hash] of Object.entries(ctx.record?.files ?? {})) {
    if (!current.has(dest)) removeRecordedFile(ctx, dest, hash);
  }
}

function restorationBefore(ctx, name) {
  const bytes = readOptional(path.join(ctx.claudeHome, name));
  const old = ctx.record?.restoration?.[name];
  if (old) return { ...old, restoreExact: old.restoreExact && sha256(bytes ?? '') === old.installedSha256 };
  let baseline = bytes;
  if (bytes && name === 'CLAUDE.md') {
    const text = bytes.toString('utf8');
    const range = markerRange(text);
    if (range) baseline = Buffer.from(`${text.slice(0, range.start)}${text.slice(range.end)}`);
  }
  if (bytes && name === 'settings.json') {
    const settings = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const before = JSON.stringify(settings);
    removeHooks(null, settings, ctx.prepared.hooks);
    removeLunaKeys(settings);
    if (JSON.stringify(settings) !== before) baseline = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
  }
  return { before: baseline?.toString('base64') ?? null, restoreExact: !ctx.record };
}

function saveRecord(ctx, manifest, restoration, created) {
  if (ctx.dryRun) return;
  const files = {};
  for (const file of manifest.files) {
    const preexistingConfig = file.kind === 'config-if-absent' && ctx.prepared.existingFiles.has(file.dest);
    if (preexistingConfig && !Object.hasOwn(ctx.record?.files ?? {}, file.dest)) continue;
    files[file.dest] = preexistingConfig ? ctx.record.files[file.dest]
      : sha256(fs.readFileSync(resolveInside(ctx.claudeHome, file.dest)));
  }
  for (const [name, meta] of Object.entries(restoration)) {
    const bytes = fs.readFileSync(path.join(ctx.claudeHome, name));
    meta.installedSha256 = sha256(bytes);
    if (name === 'CLAUDE.md') {
      const block = managedBlock(bytes);
      meta.managedSha256 = block === null ? null : sha256(block);
    } else {
      const settings = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      meta.managed = managedSettings(settings, ctx.prepared.fragment, ctx.prepared.hooks);
    }
  }
  const commit = runCommand('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  const repoCommit = commit.status === 0 ? commit.stdout.trim() : null;
  const patches = ctx.prepared.patches;
  const patchedFiles = ctx.noPluginPatch || !patches ? [] : expandRoots(ctx.claudeHome, patches.roots).flatMap(root =>
    patches.files.flatMap(file => {
      const target = resolveInside(root, file.rel);
      const bytes = readOptional(target);
      if (!restorable(bytes, readOptional(`${target}.orig-luna-harness`), file)) return [];
      return [path.relative(ctx.claudeHome, target).replaceAll('\\', '/')];
    }));
  const pluginFiles = [...new Set([...(ctx.record?.pluginFiles ?? []), ...patchedFiles])];
  const record = {
    v: 1, installedAt: ctx.record?.installedAt ?? new Date().toISOString(), repoCommit, files,
    ...(ctx.collectorUnitSha256 ? { collectorUnitSha256: ctx.collectorUnitSha256 } : {}),
    ...(ctx.collectorNode ? { collectorNode: ctx.collectorNode, previousCollectorNode: ctx.previousCollectorNode } : {}),
    ...(ctx.collectorRestartPending ? { collectorRestartPending: true } : {}),
    hooks: ctx.prepared.hooks, marketplaces: ['luna-local'], ...created, restoration, pluginFiles,
  };
  if (ctx.record && JSON.stringify(record) !== JSON.stringify(ctx.record)) {
    record.installedAt = new Date().toISOString();
  }
  const target = path.join(ctx.claudeHome, RECORD);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const previous = readOptional(target);
  if (!previous?.equals(bytes)) {
    const changed = verifyTarget(ctx, target, previous);
    if (changed && previous) backupLocalEdit(ctx, target, previous, undefined, true);
    atomicWrite(target, bytes);
  }
}

function restoreExact(ctx, name, current) {
  const meta = ctx.record.restoration?.[name];
  if (!meta?.restoreExact || sha256(current ?? '') !== meta.installedSha256) return false;
  const target = path.join(ctx.claudeHome, name);
  if (meta.before === null) removeFile(ctx, target);
  else writeManaged(ctx, target, Buffer.from(meta.before, 'base64'));
  return true;
}

function removeLunaKeys(settings) {
  const keys = [
    ['extraKnownMarketplaces', 'luna-local'],
    ['enabledPlugins', 'luna-panel@luna-local'],
    ['enabledPlugins', 'pstack@luna-local'],
  ];
  for (const [key, name] of keys) {
    if (!settings[key]) continue;
    requireObject(settings[key], key);
    if (!Object.hasOwn(settings[key], name)) continue;
    delete settings[key][name];
    if (!Object.keys(settings[key]).length) delete settings[key];
  }
}

function uninstallPatchSet(ctx) {
  for (const root of [path.join(ctx.claudeHome, 'luna-harness'), ctx.payload]) {
    try {
      return loadPatchSet(path.join(root, 'codex-plugin-patches/manifest.json'));
    } catch {
      continue;
    }
  }
  report(ctx, 'warn', 'Plugin patch manifest unavailable; plugin backups will not be restored');
  return null;
}

function uninstall(ctx) {
  ctx.record = readRecord(ctx, true);
  const settingsPath = path.join(ctx.claudeHome, 'settings.json');
  const previous = readOptional(settingsPath);
  const settings = previous ? requireObject(readJson(settingsPath), 'settings.json') : {};
  removeHooks(null, settings, ctx.record.hooks);
  removeLunaKeys(settings);
  const mdPath = path.join(ctx.claudeHome, 'CLAUDE.md');
  const md = readOptional(mdPath);
  const range = md ? markerRange(md.toString('utf8')) : null;
  const patches = ctx.platform === 'win32' ? uninstallPatchSet(ctx) : null;
  if (!patches && ctx.platform === 'linux' && ctx.record.pluginFiles?.length) {
    report(ctx, 'warn', 'Recorded Windows plugin patches were left untouched on Linux');
  }
  uninstallCollectorSupervisor(ctx);
  if (previous) {
    const backup = readOptional(`${settingsPath}${BACKUP_SUFFIX}`);
    if (!backup) backupOnce(ctx, settingsPath);
    else if (!backup.equals(previous)) backupOnce(ctx, settingsPath, timestampedSuffix(settingsPath));
    for (const identity of ctx.record.hooks) report(ctx, 'ok', `${ctx.dryRun ? 'Would remove' : 'Remove'} ${identity}`);
    if (!restoreExact(ctx, 'settings.json', previous)) {
      writeManaged(ctx, settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }
  if (md && !restoreExact(ctx, 'CLAUDE.md', md) && range) {
    const text = md.toString('utf8');
    writeManaged(ctx, mdPath, `${text.slice(0, range.start)}${text.slice(range.end)}`);
  }
  for (const [dest, hash] of Object.entries(ctx.record.files)) removeRecordedFile(ctx, dest, hash);
  for (const relative of patches ? ctx.record.pluginFiles ?? [] : []) {
    const target = resolveInside(ctx.claudeHome, relative);
    const file = patches.files.find(file => relative.replaceAll('\\', '/')
      .endsWith(`/${file.rel.replaceAll('\\', '/')}`));
    const bytes = readOptional(target);
    const original = readOptional(`${target}.orig-luna-harness`);
    if (restorable(bytes, original, file)) {
      writeManaged(ctx, target, original);
    } else {
      const reason = !file || !bytes || matchPatch(bytes, file).status !== 'patched'
        ? 'changed since install' : 'backup does not match';
      report(ctx, 'warn', `${target}: ${reason}; kept target and backup`);
    }
  }
  if (ctx.record.createdEnv) removeFile(ctx, path.join(ctx.claudeHome, 'luna-harness.env'));
  if (ctx.record.createdSentinel) removeFile(ctx, path.join(ctx.claudeHome, 'codex-gate-runner-off'));
  removeFile(ctx, path.join(ctx.claudeHome, RECORD));
  if (!ctx.dryRun) removeEmptyParents(ctx, Object.keys(ctx.record.files));
  printSummary(ctx);
  return 0;
}

// Directories that only held our files are left empty by uninstall: remove them, deepest first, never the
// Claude home itself and never a directory that still has anything in it.
function removeEmptyParents(ctx, dests) {
  const dirs = new Set();
  for (const dest of dests) {
    let dir = path.dirname(resolveInside(ctx.claudeHome, dest));
    while (dir.length > ctx.claudeHome.length && dir.startsWith(ctx.claudeHome)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // Missing or not empty: leave it.
    }
  }
}

function install(ctx, preflightFn = preflight) {
  try {
    return installPrepared(ctx, preflightFn);
  } catch (error) {
    if (!(error instanceof LocalDriftError)) throw error;
    report(ctx, 'FAIL', `${error.message}; stopped with exit 3. ${ctx.written} files already written remain in place.`);
    for (const file of ctx.writtenPaths ?? []) ctx.log(`  Already written: ${file}`);
    printSummary(ctx);
    return 3;
  }
}

function installPrepared(ctx, preflightFn) {
  if (ctx.uninstall) return uninstall(ctx);
  const manifestPath = path.join(ctx.payload, 'manifest.json');
  let manifest;
  if (!(ctx.dryRun && ctx.check) || fs.existsSync(manifestPath)) {
    manifest = readJson(manifestPath);
    ctx.record = readRecord(ctx);
    prepareInstall(ctx, manifest);
    for (const target of ctx.prepared.driftedFiles) report(ctx, 'warn', `Local drift: ${target}`);
    if (ctx.prepared.driftedFiles.length) {
      report(ctx, 'warn', 'A three-way merge is the usual fix; --accept-local-drift backs up and replaces local edits.');
      if (!ctx.acceptLocalDrift) {
        report(ctx, 'FAIL', 'Installation refused due to local drift; nothing written (exit 3).');
        printSummary(ctx);
        return 3;
      }
    }
  }
  preflightFn(ctx);
  const checkAfterInstall = ctx.check && ctx.ownerSetup && !ctx.dryRun;
  let supervisorCheck = ctx.check && !checkAfterInstall ? checkCollectorSupervisor(ctx) : 0;
  let checkStatus = 0;
  if (!(ctx.dryRun && ctx.check)) {
    const restoration = Object.fromEntries(['settings.json', 'CLAUDE.md'].map(name =>
      [name, restorationBefore(ctx, name)]));
    const created = {
      createdSentinel: ctx.record?.createdSentinel === true
        || !fs.existsSync(path.join(ctx.claudeHome, 'codex-gate-runner-off')),
      createdEnv: ctx.record?.createdEnv === true || (ctx.platform === 'win32'
        && !fs.existsSync(path.join(ctx.claudeHome, 'luna-harness.env'))),
    };
    const legacy = !ctx.record?.collectorUnitSha256 && !ctx.record?.collectorNode;
    const manageSupervisor = !ctx.dryRun && !supervisorDisabled(ctx);
    const previousInstance = manageSupervisor ? collectorOwner(collectorLock(collectorRunDirs(ctx)[0]))?.instance : null;
    if (manageSupervisor && legacy && !stopInstalledCollector(ctx, { legacy })) {
      throw new Error('Could not stop the legacy collector before upgrading');
    }
    pruneUpgrade(ctx, manifest);
    installFiles(ctx, manifest);
    installSettings(ctx, resolveInside(ctx.payload, manifest.settings));
    installClaudeMd(ctx, resolveInside(ctx.payload, manifest.claudeMd));
    if (ctx.platform === 'win32') installEnv(ctx);
    installSentinel(ctx);
    if (ctx.platform === 'win32') {
      if (ctx.noPluginPatch) skip(ctx, 'Plugin patches disabled by --no-plugin-patch');
      else patchPlugins(ctx, resolveInside(ctx.payload, manifest.pluginPatches));
      checkCustomCodex(ctx);
    }
    let unitChanged = false;
    if (ctx.platform === 'linux') {
      const bytes = collectorUnitBytes(ctx);
      unitChanged = writeManaged(ctx, collectorUnit(ctx), bytes);
      ctx.collectorUnitSha256 = sha256(bytes);
    }
    const changed = Boolean(ctx.record?.collectorRestartPending) || unitChanged ||
      (ctx.platform === 'win32' && ctx.collectorNode !== ctx.record?.collectorNode) ||
      COLLECTOR_DEPENDENCIES.some((dest) => ctx.writtenPaths?.has(path.join(ctx.claudeHome, dest)));
    const supervised = installCollectorSupervisor(ctx, changed, previousInstance);
    ctx.collectorRestartPending = changed && !supervised;
    saveRecord(ctx, manifest, restoration, created);
  }
  const externalStatus = configureExternals(ctx);
  refreshLocalPlugins(ctx);
  if (ctx.check) checkStatus = runChecks(ctx);
  if (checkAfterInstall) supervisorCheck = checkCollectorSupervisor(ctx);
  printSummary(ctx);
  return externalStatus || checkStatus || supervisorCheck;
}

function main() {
  let ctx;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(USAGE); return 0; }
    if (options.selfTest) return selfTest({
      REPO_ROOT, BACKUP_SUFFIX, BEGIN, END, RECORD, USAGE, parseArgs, makeContext,
      sha256, assertHash, resolveInside, atomicWrite, backupOnce, runCommand, commandOutput,
      readJson, installFiles, substitutePlaceholders, installSettings, installClaudeMd,
      installEnv, installSentinel, patchPlugins, walkFiles, runChecks, hookIdentities,
      prepareInstall, install,
    });
    ctx = makeContext(options);
    return install(ctx);
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    if (!ctx) console.error(USAGE);
    if (ctx) printSummary(ctx);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
