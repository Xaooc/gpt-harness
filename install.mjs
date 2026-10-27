/**
 * Usage: node install.mjs [--home <dir>] [--platform win32|linux] [--codex-build-root <winpath>]
 *   [--dry-run] [--check] [--no-plugin-patch] [--yes] [--uninstall] [--help]
 * Run node install.mjs --self-test for isolated tests using a tiny temporary payload.
 */
import assert from 'node:assert/strict';
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
const USAGE = 'Usage: node install.mjs [--home <dir>] [--platform win32|linux] [--codex-build-root <winpath>]\n'
  + '  [--dry-run] [--check] [--no-plugin-patch] [--yes] [--uninstall] [--self-test] [--help]';

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

function backupLocalEdit(ctx, file, previous, dest) {
  const recorded = ctx.record?.files[dest];
  if (recorded && sha256(previous) === recorded) return;
  const backup = `${file}${timestampedSuffix(file)}`;
  if (!ctx.dryRun) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  ctx.backups++;
  report(ctx, 'warn', `local edits saved to ${backup}${ctx.dryRun ? ' (planned only)' : ''}`);
}

function writeManaged(ctx, file, bytes, options = {}) {
  bytes = Buffer.from(bytes);
  const previous = readOptional(file);
  if (previous && (options.configIfAbsent || previous.equals(bytes))) {
    skip(ctx, `${file}${options.configIfAbsent ? ' (config already exists)' : ' (identical)'}`);
    return false;
  }
  if (previous && options.dest) backupLocalEdit(ctx, file, previous, options.dest);
  backupOnce(ctx, file, options.backupSuffix);
  if (!ctx.dryRun) {
    (options.writer ?? atomicWrite)(file, bytes);
    if (options.sha256) assertHash(fs.readFileSync(file), options.sha256, file);
  }
  ctx.written++;
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
    if (!codex) report(ctx, 'warn', 'codex not found on PATH; install @openai/codex@0.164.0');
    else {
      report(ctx, 'ok', `codex: ${codex}`);
      if (ctx.dryRun) report(ctx, 'warn', 'Codex model check skipped during dry-run to avoid CLI writes');
      else {
        const models = runCommand(codex, ['debug', 'models'], { env: homeEnvironment(ctx) });
        const available = models.status === 0 && /\bgpt-6\.1-terra\b/.test(commandOutput(models));
        report(ctx, available ? 'ok' : 'warn', available ? 'Codex model available: gpt-6.1-terra'
          : 'codex debug models did not list gpt-6.1-terra');
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
    : 'codex --version failed; install Codex 0.164.0');
  const powershell = findExecutable('pwsh') ?? findExecutable('powershell');
  report(ctx, powershell ? 'ok' : 'warn', powershell ? `PowerShell: ${powershell}` : 'PowerShell not found');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
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
  let attempted = false;
  try {
    const settings = previous ? JSON.parse(previous.toString('utf8').replace(/^\uFEFF/, '')) : {};
    const fragment = ctx.prepared?.fragment ?? substitutePlaceholders(readJson(fragmentPath), ctx.claudeHome);
    removeHooks(ctx, settings, ctx.droppedHooks ?? []);
    const next = `${JSON.stringify(mergeSettings(settings, fragment), null, 2)}\n`;
    if (previous?.equals(Buffer.from(next))) {
      skip(ctx, 'settings.json already merged');
      return;
    }
    backupOnce(ctx, file);
    if (!ctx.dryRun) {
      attempted = true;
      writer(file, next);
      requireObject(readJson(file), 'written settings.json');
      if (!fs.readFileSync(file).equals(Buffer.from(next))) throw new Error('Settings write verification failed');
    }
    ctx.written++;
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

function installClaudeMd(ctx, source) {
  const file = path.join(ctx.claudeHome, 'CLAUDE.md');
  const payload = fs.readFileSync(source, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  const block = `${BEGIN}\n${payload}\n${END}`;
  const previous = readOptional(file);
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
  } else {
    writeManaged(ctx, file, `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}\n`);
    report(ctx, 'warn', 'CLAUDE.md block appended; merge duplicates in your existing instructions if needed');
  }
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
  writeManaged(ctx, file, next);
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
      report(ctx, 'warn', 'codex@openai-codex not installed yet: run `/plugin install codex@openai-codex`'
        + ' in Claude Code, then re-run install.mjs');
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
  if (!ctx.uninstall) {
    if (ctx.platform === 'linux') {
      ctx.log('Next steps: install codex@openai-codex via /plugin install codex@openai-codex.');
    } else {
      ctx.log('Next steps: build custom Codex using codex-build/BUILD.md if needed;');
      ctx.log('  install codex@openai-codex via /plugin install codex@openai-codex, then re-run install.mjs.');
    }
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

function prepareInstall(ctx, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported payload manifest');
  const existingFiles = new Set();
  const destinations = new Set();
  for (const file of manifest.files) {
    if (!['file', 'config-if-absent', 'binary'].includes(file.kind)) {
      throw new Error(`Unknown payload kind: ${file.kind}`);
    }
    if (file.executable !== undefined && typeof file.executable !== 'boolean') {
      throw new Error(`Invalid executable flag: ${file.src}`);
    }
    const source = resolveInside(ctx.payload, file.src);
    assertHash(fs.readFileSync(source), file.sha256, source);
    const target = resolveInside(ctx.claudeHome, file.dest);
    if (destinations.has(file.dest)) throw new Error(`Duplicate payload destination: ${file.dest}`);
    destinations.add(file.dest);
    if (fs.existsSync(target)) existingFiles.add(file.dest);
  }
  const settingsPath = path.join(ctx.claudeHome, 'settings.json');
  const settings = fs.existsSync(settingsPath) ? requireObject(readJson(settingsPath), 'settings.json') : {};
  const settingsSource = resolveInside(ctx.payload, manifest.settings);
  if (ctx.platform === 'linux' || Object.hasOwn(manifest, 'settingsSha256')) {
    assertHash(fs.readFileSync(settingsSource), manifest.settingsSha256, settingsSource);
  }
  const fragment = substitutePlaceholders(readJson(settingsSource), ctx.claudeHome);
  const hooks = hookIdentities(mergeSettings({}, structuredClone(fragment)));
  const droppedHooks = (ctx.record?.hooks ?? []).filter(identity => !hooks.includes(identity));
  removeHooks(null, settings, droppedHooks);
  mergeSettings(settings, structuredClone(fragment));
  const md = readOptional(path.join(ctx.claudeHome, 'CLAUDE.md'));
  if (md) markerRange(md.toString('utf8'));
  const mdSource = resolveInside(ctx.payload, manifest.claudeMd);
  const mdBytes = fs.readFileSync(mdSource);
  if (ctx.platform === 'linux' || Object.hasOwn(manifest, 'claudeMdSha256')) {
    assertHash(mdBytes, manifest.claudeMdSha256, mdSource);
  }
  let patches = null;
  if (ctx.platform === 'win32') {
    patches = loadPatchSet(resolveInside(ctx.payload, manifest.pluginPatches));
    for (const root of expandRoots(ctx.claudeHome, patches.roots)) {
      for (const file of patches.files) resolveInside(root, file.rel);
    }
  }
  if (ctx.platform === 'win32' && ctx.codexBuildRoot && /[\r\n]/.test(ctx.codexBuildRoot)) {
    throw new Error('Custom Codex root cannot contain a newline');
  }
  ctx.droppedHooks = droppedHooks;
  ctx.prepared = { fragment, hooks, patches, existingFiles };
}

function protectedData(dest) {
  return /^(?:luna-run|learning)(?:\/|$)/.test(dest.replaceAll('\\', '/'))
    || /\.(?:bak|orig)-luna-harness/.test(dest);
}

function removeFile(ctx, file) {
  if (!fs.existsSync(file)) return;
  if (!ctx.dryRun) fs.unlinkSync(file);
  ctx.written++;
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
    meta.installedSha256 = sha256(fs.readFileSync(path.join(ctx.claudeHome, name)));
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
    hooks: ctx.prepared.hooks, marketplaces: ['luna-local'], ...created, restoration, pluginFiles,
  };
  if (ctx.record && JSON.stringify(record) !== JSON.stringify(ctx.record)) {
    record.installedAt = new Date().toISOString();
  }
  const target = path.join(ctx.claudeHome, RECORD);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  if (!readOptional(target)?.equals(bytes)) atomicWrite(target, bytes);
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
  for (const [key, name] of [['extraKnownMarketplaces', 'luna-local'], ['enabledPlugins', 'luna-panel@luna-local']]) {
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
  if (ctx.uninstall) return uninstall(ctx);
  preflightFn(ctx);
  let checkStatus = 0;
  if (!(ctx.dryRun && ctx.check)) {
    const manifest = readJson(path.join(ctx.payload, 'manifest.json'));
    ctx.record = readRecord(ctx);
    prepareInstall(ctx, manifest);
    const restoration = Object.fromEntries(['settings.json', 'CLAUDE.md'].map(name =>
      [name, restorationBefore(ctx, name)]));
    const created = {
      createdSentinel: ctx.record?.createdSentinel === true
        || !fs.existsSync(path.join(ctx.claudeHome, 'codex-gate-runner-off')),
      createdEnv: ctx.record?.createdEnv === true || (ctx.platform === 'win32'
        && !fs.existsSync(path.join(ctx.claudeHome, 'luna-harness.env'))),
    };
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
    saveRecord(ctx, manifest, restoration, created);
  }
  if (ctx.check) checkStatus = runChecks(ctx);
  printSummary(ctx);
  return checkStatus;
}

function fakePayload(root) {
  const payload = path.join(root, 'payload');
  const put = (relative, text) => atomicWrite(path.join(payload, relative), text);
  const files = [
    ['claude/scripts/example.mjs', 'scripts/example.mjs', 'file', 'export const version = 1;\n'],
    ['claude/learning/config.json', 'learning/config.json', 'config-if-absent', '{"default":true}\n'],
    ['claude/bin/example.exe', 'bin/example.exe', 'binary', Buffer.from([0, 1, 2, 255])],
  ];
  const manifest = {
    version: 1,
    files: files.map(([src, dest, kind, text]) => {
      put(src, text);
      return { src, dest, kind, sha256: sha256(text) };
    }),
    settings: 'settings/hooks.json',
    claudeMd: 'claude-md/harness-section.md',
    pluginPatches: 'codex-plugin-patches/manifest.json',
  };
  const hook = arg => ({
    type: 'command', command: `"{{NODE}}" "{{CLAUDE_HOME}}/scripts/example.mjs" ${arg}`, timeout: 20,
  });
  put(manifest.settings, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook('pre'), hook('extra')] }] },
    extraKnownMarketplaces: {
      luna: { source: { path: '{{CLAUDE_HOME_WIN}}\\plugins' } },
      'luna-local': { source: { path: '{{CLAUDE_HOME_WIN}}\\local-plugins' } },
    },
    enabledPlugins: { 'codex@openai-codex': true, 'luna-panel@luna-local': true },
  }));
  put(manifest.claudeMd, 'Harness instructions.\n');
  const original = 'original plugin\n';
  const patched = 'patched plugin\n';
  const originalB = 'upstream original plugin\n';
  const patchedB = 'upstream patched plugin\n';
  put('codex-plugin-patches/patched/plugin.mjs', patched);
  put('codex-plugin-patches/orig/plugin.mjs', original);
  put('codex-plugin-patches/1.0.6/patched/plugin.mjs', patchedB);
  put('codex-plugin-patches/1.0.6/orig/plugin.mjs', originalB);
  put(manifest.pluginPatches, JSON.stringify({
    plugin: 'codex@openai-codex', versions: ['1.0.3', '1.0.6'], roots: ['plugins/test'],
    files: [{ rel: 'plugin.mjs', variants: [
      { versions: ['1.0.3'], origSha256: sha256(original), patchedSha256: sha256(patched),
        patched: 'patched/plugin.mjs', orig: 'orig/plugin.mjs' },
      { versions: ['1.0.6'], origSha256: sha256(originalB), patchedSha256: sha256(patchedB),
        patched: '1.0.6/patched/plugin.mjs', orig: '1.0.6/orig/plugin.mjs' },
    ] }],
  }));
  put('manifest.json', JSON.stringify(manifest));
  return { payload, manifest, original, patched, originalB, patchedB };
}

function snapshot(root) {
  if (!fs.existsSync(root)) return null;
  const entries = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      entries.push([path.relative(root, file), entry.isDirectory() ? 'directory' : sha256(fs.readFileSync(file))]);
      if (entry.isDirectory()) visit(file);
    }
  }
  visit(root);
  return entries;
}

function selfTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-harness-self-test-'));
  let passed = 0;
  const winContext = options => makeContext({ platform: 'win32', ...options });
  const test = (name, action) => {
    action();
    passed++;
    console.log(`[ok] PASS ${name}`);
  };
  try {
    const fixture = fakePayload(temp);
    const { payload, manifest } = fixture;
    const ctx = winContext({ home: path.join(temp, 'home with spaces'), payload, log: () => {} });
    const ch = ctx.claudeHome;
    const settingsPath = path.join(ch, 'settings.json');
    const fragmentPath = path.join(payload, manifest.settings);
    const mdSource = path.join(payload, manifest.claudeMd);
    const mdPath = path.join(ch, 'CLAUDE.md');
    const json = value => `${JSON.stringify(value, null, 2)}\n`;
    test('platform selection and argument validation', () => {
      assert.equal(parseArgs(['--platform', 'linux']).payload, path.join(REPO_ROOT, 'payload-linux'));
      assert.equal(parseArgs(['--platform', 'win32']).payload, path.join(REPO_ROOT, 'payload'));
      if (['win32', 'linux'].includes(process.platform)) {
        assert.equal(parseArgs([]).platform, process.platform);
      }
      assert.throws(() => parseArgs(['--platform', 'darwin']), /Unsupported platform/);
      assert.throws(() => parseArgs(['--platform', 'darwin', '--self-test']), /Unsupported platform/);
      assert.throws(() => parseArgs(['--platform']), /Missing value/);
      assert.equal(parseArgs(['--help']).help, true);
      assert.match(USAGE, /--dry-run.*--check/);
    });
    test('Linux payload hashes cover installed files and both settings assets', () => {
      const linuxPayload = path.join(REPO_ROOT, 'payload-linux');
      const linuxManifest = readJson(path.join(linuxPayload, 'manifest.json'));
      const listed = new Set(linuxManifest.files.map(file => resolveInside(linuxPayload, file.src)));
      assert.deepEqual([...listed].sort(), walkFiles(path.join(linuxPayload, 'claude')).sort());
      assert.ok(linuxManifest.files.some(file => file.dest === 'scripts/lib/luna-linux-test.mjs'));
      const linuxCtx = makeContext({ home: path.join(temp, 'linux-hash-home'), platform: 'linux',
        payload: linuxPayload, log: () => {} });
      prepareInstall(linuxCtx, linuxManifest);
      for (const key of ['settingsSha256', 'claudeMdSha256']) {
        assert.match(linuxManifest[key], /^[a-f0-9]{64}$/);
        assert.throws(() => prepareInstall(linuxCtx, { ...linuxManifest, [key]: '0'.repeat(64) }), /SHA256 mismatch/);
        assert.throws(() => prepareInstall(linuxCtx, { ...linuxManifest, [key]: undefined }), /SHA256 mismatch/);
      }
      assert.equal(fs.existsSync(linuxCtx.home), false);
    });
    test('Linux install uses Linux hooks and skips Windows environment and patch steps', () => {
      const home = path.join(temp, 'linux home with spaces');
      const options = { home, platform: 'linux', payload: path.join(REPO_ROOT, 'payload-linux'), log: () => {} };
      const linux = makeContext(options);
      const plugin = path.join(linux.claudeHome, 'plugins/test/plugin.mjs');
      atomicWrite(plugin, 'unpatched plugin');
      const before = snapshot(home);
      assert.equal(install(makeContext({ ...options, dryRun: true }), () => {}), 0);
      assert.deepEqual(snapshot(home), before);
      assert.equal(install(linux, () => {}), 0);
      assert.equal(fs.readFileSync(plugin, 'utf8'), 'unpatched plugin');
      assert.equal(fs.existsSync(path.join(linux.claudeHome, 'luna-harness.env')), false);
      assert.equal(fs.existsSync(path.join(linux.claudeHome, 'bin/luna-sh')), false);
      assert.equal(fs.existsSync(path.join(linux.claudeHome, 'luna-harness/codex-plugin-patches')), false);
      assert.equal(fs.existsSync(path.join(linux.claudeHome, 'scripts/pytest_gate.py')), true);
      const record = readJson(path.join(linux.claudeHome, RECORD));
      assert.equal(record.createdEnv, false);
      assert.deepEqual(record.pluginFiles, []);
      const manifest = readJson(path.join(options.payload, 'manifest.json'));
      const fragment = substitutePlaceholders(readJson(path.join(options.payload, manifest.settings)), linux.claudeHome);
      const settings = readJson(path.join(linux.claudeHome, 'settings.json'));
      assert.equal(fragment.extraKnownMarketplaces['luna-local'].source.path,
        `${linux.claudeHome.replaceAll('\\', '/')}/local-plugins`);
      for (const [event, entries] of Object.entries(fragment.hooks)) {
        for (const entry of entries) for (const hook of entry.hooks) {
          assert.ok(hook.command.startsWith(`"${process.execPath.replaceAll('\\', '/')}" `));
          assert.ok(hook.command.includes(`"${linux.claudeHome.replaceAll('\\', '/')}/`));
          assert.equal(settings.hooks[event].flatMap(item => item.hooks)
            .filter(item => item.command === hook.command).length, 1);
        }
      }
      assert.equal(fragment.hooks.PreToolUse.find(entry => entry.hooks[0].command.endsWith('hook-pre')).matcher,
        'Bash');
      assert.equal(fragment.hooks.PostToolUse.find(entry => entry.hooks[0].command.endsWith('hook-post')).matcher,
        'Bash');
      if (process.platform !== 'win32') {
        const script = path.join(linux.claudeHome, 'scripts/luna.sh');
        assert.ok(fs.statSync(script).mode & 0o100);
      }
      const second = makeContext(options);
      assert.equal(install(second, () => {}), 0);
      assert.equal(second.written, 0);
      const installed = snapshot(home);
      assert.equal(install(makeContext({ ...options, uninstall: true, dryRun: true })), 0);
      assert.deepEqual(snapshot(home), installed);
      assert.equal(install(makeContext({ ...options, uninstall: true })), 0);
      assert.equal(fs.readFileSync(plugin, 'utf8'), 'unpatched plugin');
      assert.equal(fs.existsSync(path.join(linux.claudeHome, RECORD)), false);
    });
    test('placeholder substitution handles Windows backslashes and paths with spaces', () => {
      const result = substitutePlaceholders(readJson(fragmentPath), ch);
      assert.ok(result.hooks.PreToolUse[0].hooks[0].command.includes(process.execPath.replaceAll('\\', '/')));
      assert.ok(result.hooks.PreToolUse[0].hooks[0].command.includes(`${ch.replaceAll('\\', '/')}/scripts/`));
      assert.equal(result.extraKnownMarketplaces.luna.source.path, `${ch.replaceAll('/', '\\')}\\plugins`);
      assert.ok(!JSON.stringify(result).includes('{{'));
    });
    const foreign = { type: 'command', command: 'echo user-hook', timeout: 77 };
    const existing = {
      userSetting: true,
      hooks: { PreToolUse: [{ matcher: 'Old', hooks: [foreign, {
        type: 'command', command: `node "${ch}/scripts/example.mjs" pre`, timeout: 1,
      }, { type: 'command', command: 'echo user-after' }] }], Stop: [{ hooks: [foreign] }] },
      extraKnownMarketplaces: { user: { source: 'keep' } },
      enabledPlugins: { user: true, 'codex@openai-codex': false },
    };
    atomicWrite(settingsPath, json(existing));
    test('hook merge replaces same identity, appends new, preserves foreign hooks and settings', () => {
      installSettings(ctx, fragmentPath);
      const settings = readJson(settingsPath);
      const entries = settings.hooks.PreToolUse;
      assert.equal(entries.length, 4);
      assert.deepEqual(entries[0], { matcher: 'Old', hooks: [foreign] });
      assert.equal(entries[1].matcher, 'Bash');
      assert.equal(entries[1].hooks[0].timeout, 20);
      assert.deepEqual(entries[2], { matcher: 'Old', hooks: [{ type: 'command', command: 'echo user-after' }] });
      assert.ok(entries[3].hooks[0].command.endsWith(' extra'));
      assert.deepEqual(settings.hooks.Stop, existing.hooks.Stop);
      assert.equal(settings.userSetting, true);
      assert.deepEqual(settings.extraKnownMarketplaces.user, existing.extraKnownMarketplaces.user);
      assert.equal(settings.enabledPlugins.user, true);
      assert.equal(settings.enabledPlugins['codex@openai-codex'], true);
      const before = fs.readFileSync(settingsPath);
      const writes = ctx.written;
      installSettings(ctx, fragmentPath);
      assert.deepEqual(fs.readFileSync(settingsPath), before);
      assert.equal(ctx.written, writes);
    });
    test('settings restores current user edits on invalid write, preserves first backup', () => {
      const originalBackup = fs.readFileSync(`${settingsPath}${BACKUP_SUFFIX}`);
      const edited = { ...readJson(settingsPath), newUserEdit: 'retain' };
      edited.hooks.PreToolUse[1].hooks[0].timeout = 999;
      atomicWrite(settingsPath, json(edited));
      const before = fs.readFileSync(settingsPath);
      assert.throws(() => installSettings(ctx, fragmentPath, (file) => atomicWrite(file, '{invalid')), /merge failed/);
      assert.deepEqual(fs.readFileSync(settingsPath), before);
      assert.deepEqual(fs.readFileSync(`${settingsPath}${BACKUP_SUFFIX}`), originalBackup);
    });
    test('CLAUDE.md missing, marked replacement, equal unmarked, and different unmarked', () => {
      installClaudeMd(ctx, mdSource);
      assert.equal(fs.readFileSync(mdPath, 'utf8'), `${BEGIN}\nHarness instructions.\n${END}\n`);
      atomicWrite(mdPath, `User before\n${BEGIN}\nold\n${END}\nUser after\n`);
      installClaudeMd(ctx, mdSource);
      const marked = `User before\n${BEGIN}\nHarness instructions.\n${END}\nUser after\n`;
      assert.equal(fs.readFileSync(mdPath, 'utf8'), marked);
      atomicWrite(mdPath, 'Harness instructions.  \r\n\r\n');
      const before = fs.readFileSync(mdPath);
      installClaudeMd(ctx, mdSource);
      assert.deepEqual(fs.readFileSync(mdPath), before);
      atomicWrite(mdPath, 'User instructions.\n');
      installClaudeMd(ctx, mdSource);
      assert.equal(fs.readFileSync(mdPath, 'utf8'), `User instructions.\n\n${BEGIN}\nHarness instructions.\n${END}\n`);
      const after = fs.readFileSync(mdPath);
      installClaudeMd(ctx, mdSource);
      assert.deepEqual(fs.readFileSync(mdPath), after);
    });
    test('config-if-absent, binary hash verification, and backups created once only', () => {
      const config = path.join(ch, 'learning/config.json');
      const script = path.join(ch, 'scripts/example.mjs');
      atomicWrite(config, '{"user":true}');
      atomicWrite(script, 'user old script');
      installFiles(ctx, manifest);
      assert.equal(fs.readFileSync(config, 'utf8'), '{"user":true}');
      assert.equal(fs.readFileSync(`${script}${BACKUP_SUFFIX}`, 'utf8'), 'user old script');
      assertHash(fs.readFileSync(path.join(ch, 'bin/example.exe')), manifest.files[2].sha256, 'binary');
      const backups = ctx.backups;
      atomicWrite(script, 'second edit');
      installFiles(ctx, manifest);
      assert.equal(ctx.backups, backups);
      assert.equal(fs.readFileSync(`${script}${BACKUP_SUFFIX}`, 'utf8'), 'user old script');
      atomicWrite(path.join(payload, manifest.files[0].src), 'corrupt');
      assert.throws(() => installFiles(ctx, manifest), /SHA256 mismatch/);
      atomicWrite(path.join(payload, manifest.files[0].src), 'export const version = 1;\n');
    });
    test('plugin original to patched, already patched, unknown version, and missing root', () => {
      const plugin = path.join(ch, 'plugins/test/plugin.mjs');
      const patchManifest = path.join(payload, manifest.pluginPatches);
      atomicWrite(plugin, fixture.original);
      patchPlugins(ctx, patchManifest);
      assert.equal(fs.readFileSync(plugin, 'utf8'), fixture.patched);
      assert.equal(fs.readFileSync(`${plugin}.orig-luna-harness`, 'utf8'), fixture.original);
      const writes = ctx.written;
      patchPlugins(ctx, patchManifest);
      assert.equal(ctx.written, writes);
      atomicWrite(plugin, 'unknown version');
      patchPlugins(ctx, patchManifest);
      assert.equal(fs.readFileSync(plugin, 'utf8'), 'unknown version');
      assert.ok(ctx.warnings.some(warning => warning.includes('plugin version differs')));
      const missing = winContext({ home: path.join(temp, 'missing-plugin'), payload, log: () => {} });
      patchPlugins(missing, patchManifest);
      assert.ok(missing.warnings.some(warning => warning.includes('/plugin install codex@openai-codex')));
    });
    test('env preserves other keys and existing root; explicit root overrides', () => {
      const file = path.join(ch, 'luna-harness.env');
      atomicWrite(file, '# user comment\nOTHER=value=with=equals\nLUNA_CUSTOM_CODEX_ROOT=C:\\existing build\n');
      installEnv(ctx);
      assert.equal(ctx.customRoot, 'C:\\existing build');
      assert.ok(fs.readFileSync(file, 'utf8').includes('OTHER=value=with=equals\n'));
      ctx.codexBuildRoot = 'D:\\new build';
      installEnv(ctx);
      assert.ok(fs.readFileSync(file, 'utf8').includes('LUNA_CUSTOM_CODEX_ROOT=D:\\new build\n'));
      assert.ok(fs.readFileSync(file, 'utf8').startsWith('# user comment\nOTHER=value=with=equals\n'));
      const before = fs.readFileSync(file);
      const writes = ctx.written;
      installEnv(ctx);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(ctx.written, writes);
    });
    test('sentinel is empty and idempotent', () => {
      installSentinel(ctx);
      const writes = ctx.written;
      installSentinel(ctx);
      assert.equal(ctx.written, writes);
      assert.equal(fs.statSync(path.join(ch, 'codex-gate-runner-off')).size, 0);
    });
    test('dry-run reads and compares but creates no files, directories, backups, or plugin patches', () => {
      const plugin = path.join(ch, 'plugins/test/plugin.mjs');
      atomicWrite(plugin, fixture.original);
      const before = snapshot(temp);
      const dry = winContext({ home: ctx.home, payload, dryRun: true, log: () => {} });
      install(dry);
      assert.deepEqual(snapshot(temp), before);
      const missing = winContext({ home: path.join(temp, 'absent-home'), payload, dryRun: true, log: () => {} });
      install(missing);
      assert.equal(fs.existsSync(missing.home), false);
      assert.deepEqual(snapshot(temp), before);
    });
    test('full fake-payload installs write zero files and create zero backups on second run', () => {
      const options = { home: path.join(temp, 'fresh-home'), payload, log: () => {} };
      const first = winContext(options);
      assert.equal(install(first), 0);
      assert.ok(first.written > 0);
      const before = snapshot(first.home);
      const second = winContext(options);
      assert.equal(install(second), 0);
      assert.equal(second.written, 0);
      assert.equal(second.backups, 0);
      assert.deepEqual(snapshot(first.home), before);
    });
    test('dry-run plus check only checks existing installation, even without payload', () => {
      const check = winContext({ home: path.join(temp, 'no-home'), payload: 'missing', dryRun: true,
        check: true, log: () => {} });
      assert.equal(install(check), 0);
      assert.equal(fs.existsSync(check.home), false);
    });
    test('check runner isolates home, skips missing files, and propagates child failures', () => {
      const messages = [];
      const check = winContext({ home: path.join(temp, 'check-home'), log: message => messages.push(message) });
      const probe = path.join(check.claudeHome, 'scripts/heavy-gate.mjs');
      atomicWrite(probe, '// Fake check target; subprocess results injected for sandbox portability.\n');
      const hook = path.join(check.claudeHome, 'hooks/nested/check.mjs');
      atomicWrite(hook, 'export const valid = true;\n');
      const calls = [];
      const runner = (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.equal(options.env.HOME, check.home);
        assert.equal(options.env.USERPROFILE, check.home);
        assert.equal(options.cwd, check.claudeHome);
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      };
      assert.equal(runChecks(check, runner), 0);
      assert.deepEqual(calls, [[probe, '--self-test'], ['--check', hook]]);
      assert.ok(messages.some(message => message.includes('PASS | heavy-gate.mjs --self-test')));
      assert.ok(messages.some(message => message.includes('[skip] luna-reap-brokers.mjs --self-test (missing)')));
      assert.ok(messages.some(message => message.includes('Checks: 2 PASS, 0 FAIL')));
      assert.equal(runChecks(check, (command, args, options) => {
        if (args[0] === '--check') return { status: 1, stderr: 'injected child failure' };
        return runner(command, args, options);
      }), 1);
      assert.ok(messages.some(message => message.includes('Checks: 1 PASS, 1 FAIL')));
      assert.ok(messages.includes('injected child failure'));
    });
    function isolated(name) {
      const root = path.join(temp, name);
      const fixture = fakePayload(root);
      const options = { home: path.join(root, 'home'), payload: fixture.payload, log: () => {} };
      const ctx = winContext(options);
      return { ...fixture, ctx, options, ch: ctx.claudeHome };
    }
    test('auto-updated target and backup survive dry-run and real uninstall with the same warning', () => {
      const fixture = isolated('plugin-auto-update');
      const plugin = path.join(fixture.ch, 'plugins/test/plugin.mjs');
      atomicWrite(plugin, fixture.original);
      install(fixture.ctx);
      const updated = Buffer.from('auto-update unknown content\r\n');
      atomicWrite(plugin, updated);
      const backup = fs.readFileSync(`${plugin}.orig-luna-harness`);
      const before = snapshot(fixture.ctx.home);
      const dry = winContext({ ...fixture.options, uninstall: true, dryRun: true });
      assert.equal(install(dry), 0);
      assert.deepEqual(snapshot(fixture.ctx.home), before);
      const warning = `${plugin}: changed since install; kept target and backup`;
      assert.ok(dry.warnings.includes(warning));
      const remove = winContext({ ...fixture.options, uninstall: true });
      assert.equal(install(remove), 0);
      assert.ok(remove.warnings.includes(warning));
      assert.deepEqual(fs.readFileSync(plugin), updated);
      assert.deepEqual(fs.readFileSync(`${plugin}.orig-luna-harness`), backup);
    });
    test('already patched target with an unrelated backup is not adopted or restored', () => {
      const fixture = isolated('plugin-unrelated-backup');
      const plugin = path.join(fixture.ch, 'plugins/test/plugin.mjs');
      atomicWrite(plugin, fixture.patchedB);
      atomicWrite(`${plugin}.orig-luna-harness`, 'unrelated backup');
      assert.equal(install(fixture.ctx), 0);
      assert.deepEqual(readJson(path.join(fixture.ch, RECORD)).pluginFiles, []);
      assert.equal(install(winContext({ ...fixture.options, uninstall: true })), 0);
      assert.equal(fs.readFileSync(plugin, 'utf8'), fixture.patchedB);
      assert.equal(fs.readFileSync(`${plugin}.orig-luna-harness`, 'utf8'), 'unrelated backup');
    });
    test('installer refreshes stale backups atomically, including EOL-only differences on reinstall', () => {
      const fixture = isolated('plugin-stale-backup');
      const plugin = path.join(fixture.ch, 'plugins/test/plugin.mjs');
      const backup = `${plugin}.orig-luna-harness`;
      const original = fixture.originalB.replaceAll('\n', '\r\n');
      atomicWrite(plugin, original);
      atomicWrite(backup, fixture.originalB);
      const before = snapshot(fixture.ctx.home);
      const dryMessages = [];
      const dry = winContext({ ...fixture.options, dryRun: true, log: message => dryMessages.push(message) });
      assert.equal(install(dry), 0);
      assert.deepEqual(snapshot(fixture.ctx.home), before);
      assert.ok(dryMessages.some(message => message.includes(`Would refresh backup: ${plugin}`)));
      const messages = [];
      fixture.ctx.log = message => messages.push(message);
      assert.equal(install(fixture.ctx), 0);
      assert.ok(messages.some(message => message.includes(`refreshed backup: ${plugin}`)));
      assert.equal(fs.readFileSync(backup, 'utf8'), original);
      assert.equal(fs.readFileSync(plugin, 'utf8'), fixture.patchedB.replaceAll('\n', '\r\n'));
      assert.deepEqual(readJson(path.join(fixture.ch, RECORD)).pluginFiles, ['plugins/test/plugin.mjs']);
      const time = fs.statSync(backup).mtimeMs;
      atomicWrite(plugin, fixture.originalB);
      assert.equal(install(winContext(fixture.options)), 0);
      assert.notEqual(fs.statSync(backup).mtimeMs, time);
      assert.equal(fs.readFileSync(backup, 'utf8'), fixture.originalB);
    });
    test('mixed cache root stays byte-identical while a fully known root patches and restores', () => {
      const fixture = isolated('plugin-mixed-root');
      const patchManifest = path.join(fixture.payload, fixture.manifest.pluginPatches);
      const patches = readJson(patchManifest);
      patches.roots = ['plugins/cache/openai-codex/codex/*'];
      patches.files = ['one.mjs', 'two.mjs', 'three.mjs', 'four.mjs']
        .map(rel => ({ ...patches.files[0], rel }));
      atomicWrite(patchManifest, json(patches));
      const cache = path.join(fixture.ch, 'plugins/cache/openai-codex/codex');
      const inactive = path.join(cache, '1.0.2');
      const active = path.join(cache, '1.0.6');
      const original = Buffer.from(fixture.originalB.replaceAll('\n', '\r\n'));
      patches.files.forEach((file, index) => {
        atomicWrite(path.join(inactive, file.rel), index < 2 ? fixture.original : `unknown ${index}\r\n`);
        atomicWrite(path.join(active, file.rel), original);
      });
      const inactiveBefore = snapshot(inactive);
      const homeBefore = snapshot(fixture.ctx.home);
      const dry = winContext({ ...fixture.options, dryRun: true });
      assert.equal(install(dry), 0);
      assert.deepEqual(snapshot(fixture.ctx.home), homeBefore);
      assert.ok(dry.warnings.includes(`${inactive}: left unpatched, unknown plugin files`));
      assert.equal(install(fixture.ctx), 0);
      assert.deepEqual(snapshot(inactive), inactiveBefore);
      assert.ok(fixture.ctx.warnings.includes(`${inactive}: left unpatched, unknown plugin files`));
      assert.equal(fixture.ctx.warnings.filter(message => message.includes('plugin version differs')).length, 2);
      const recorded = patches.files.map(file => `plugins/cache/openai-codex/codex/1.0.6/${file.rel}`);
      assert.deepEqual(readJson(path.join(fixture.ch, RECORD)).pluginFiles, recorded);
      for (const file of patches.files) {
        assert.equal(fs.readFileSync(path.join(active, file.rel), 'utf8'),
          fixture.patchedB.replaceAll('\n', '\r\n'));
      }
      assert.equal(install(winContext({ ...fixture.options, uninstall: true })), 0);
      assert.deepEqual(snapshot(inactive), inactiveBefore);
      for (const file of patches.files) assert.deepEqual(fs.readFileSync(path.join(active, file.rel)), original);
    });
    test('cache root with a missing target remains unpatched and reports missing plugin files', () => {
      const fixture = isolated('plugin-incomplete-root');
      const patchManifest = path.join(fixture.payload, fixture.manifest.pluginPatches);
      const patches = readJson(patchManifest);
      patches.roots = ['plugins/cache/openai-codex/codex/*'];
      patches.files = ['one.mjs', 'two.mjs', 'three.mjs', 'four.mjs']
        .map(rel => ({ ...patches.files[0], rel }));
      atomicWrite(patchManifest, json(patches));
      const root = path.join(fixture.ch, 'plugins/cache/openai-codex/codex/1.0.6');
      const targets = patches.files.slice(0, 3).map(file => path.join(root, file.rel));
      targets.forEach(file => atomicWrite(file, fixture.originalB));
      const before = targets.map(file => fs.readFileSync(file));
      assert.equal(install(fixture.ctx), 0);
      targets.forEach((file, index) => {
        assert.deepEqual(fs.readFileSync(file), before[index]);
        assert.equal(fs.existsSync(`${file}.orig-luna-harness`), false);
      });
      assert.ok(fixture.ctx.warnings.some(message => message.includes('missing plugin files: four.mjs')));
    });
    test('existing records with stale backups are retained and uninstall refuses the mismatched original', () => {
      const fixture = isolated('plugin-record-stale-backup');
      const plugin = path.join(fixture.ch, 'plugins/test/plugin.mjs');
      atomicWrite(plugin, fixture.originalB);
      install(fixture.ctx);
      atomicWrite(`${plugin}.orig-luna-harness`, fixture.original);
      assert.equal(install(winContext(fixture.options)), 0);
      assert.deepEqual(readJson(path.join(fixture.ch, RECORD)).pluginFiles, ['plugins/test/plugin.mjs']);
      const remove = winContext({ ...fixture.options, uninstall: true });
      assert.equal(install(remove), 0);
      assert.ok(remove.warnings.some(message => message.includes(`${plugin}: backup does not match`)));
      assert.equal(fs.readFileSync(plugin, 'utf8'), fixture.patchedB);
      assert.equal(fs.readFileSync(`${plugin}.orig-luna-harness`, 'utf8'), fixture.original);
    });
    test('uninstall prefers installed patches and restores nothing if both patch sets fail to load', () => {
      for (const available of [true, false]) {
        const fixture = isolated(`plugin-uninstall-manifest-${available}`);
        const plugin = path.join(fixture.ch, 'plugins/test/plugin.mjs');
        atomicWrite(plugin, fixture.originalB);
        install(fixture.ctx);
        const source = path.join(fixture.payload, 'codex-plugin-patches');
        if (available) fs.cpSync(source, path.join(fixture.ch, 'luna-harness/codex-plugin-patches'),
          { recursive: true });
        atomicWrite(path.join(source, 'manifest.json'), 'corrupt');
        const remove = winContext({ ...fixture.options, uninstall: true });
        assert.equal(install(remove), 0);
        assert.equal(fs.readFileSync(plugin, 'utf8'), available ? fixture.originalB : fixture.patchedB);
        assert.equal(fs.readFileSync(`${plugin}.orig-luna-harness`, 'utf8'), fixture.originalB);
        assert.equal(remove.warnings.filter(message => message.includes('Plugin patch manifest unavailable'))
          .length, available ? 0 : 1);
      }
    });
    test('glob cache versions install, record concrete paths, and uninstall restores exact original bytes', () => {
      const fixture = isolated('glob-versions');
      const patchManifest = path.join(fixture.payload, fixture.manifest.pluginPatches);
      const patches = readJson(patchManifest);
      patches.roots = ['plugins/cache/openai-codex/codex/*', 'plugins/marketplaces/openai-codex/plugins/codex'];
      atomicWrite(patchManifest, json(patches));
      const relA = 'plugins/cache/openai-codex/codex/1.0.3/plugin.mjs';
      const relB = 'plugins/cache/openai-codex/codex/1.0.6/plugin.mjs';
      const pluginA = path.join(fixture.ch, relA);
      const pluginB = path.join(fixture.ch, relB);
      const originalA = Buffer.from(fixture.original);
      const originalB = Buffer.from(fixture.originalB.replaceAll('\n', '\r\n'));
      atomicWrite(pluginB, originalB);
      atomicWrite(pluginA, originalA);
      const unknown = path.join(fixture.ch, 'plugins/cache/openai-codex/codex/1.0.2/plugin.mjs');
      atomicWrite(unknown, 'unknown plugin');
      atomicWrite(`${unknown}.orig-luna-harness`, 'unrelated backup');
      const before = snapshot(fixture.ctx.home);
      assert.equal(install(winContext({ ...fixture.options, dryRun: true })), 0);
      assert.deepEqual(snapshot(fixture.ctx.home), before);
      assert.equal(install(fixture.ctx), 0);
      assert.equal(fs.readFileSync(pluginA, 'utf8'), fixture.patched);
      assert.equal(fs.readFileSync(pluginB, 'utf8'), fixture.patchedB.replaceAll('\n', '\r\n'));
      assert.deepEqual(readJson(path.join(fixture.ch, RECORD)).pluginFiles, [relA, relB]);
      assert.equal(install(winContext(fixture.options)), 0);
      assert.deepEqual(readJson(path.join(fixture.ch, RECORD)).pluginFiles, [relA, relB]);
      assert.equal(install(winContext({ ...fixture.options, uninstall: true })), 0);
      assert.deepEqual(fs.readFileSync(pluginA), originalA);
      assert.deepEqual(fs.readFileSync(pluginB), originalB);
      assert.equal(fs.readFileSync(unknown, 'utf8'), 'unknown plugin');
    });
    test('absent cache directories and marketplace produce exactly one not-installed warning', () => {
      const fixture = isolated('glob-missing');
      const patchManifest = path.join(fixture.payload, fixture.manifest.pluginPatches);
      const patches = readJson(patchManifest);
      patches.roots = ['plugins/cache/openai-codex/codex/*', 'plugins/marketplaces/openai-codex/plugins/codex'];
      atomicWrite(patchManifest, json(patches));
      assert.equal(install(fixture.ctx), 0);
      assert.equal(fixture.ctx.warnings.filter(message => message.includes('not installed yet')).length, 1);
      assert.deepEqual(readJson(path.join(fixture.ch, RECORD)).pluginFiles, []);
    });
    test('install record contains installed hashes, identities, commit, timestamp, and ownership flags', () => {
      const fixture = isolated('record');
      install(fixture.ctx);
      const record = readJson(path.join(fixture.ch, RECORD));
      assert.equal(record.v, 1);
      assert.ok(Number.isFinite(Date.parse(record.installedAt)));
      assert.ok(record.repoCommit === null || /^[a-f0-9]{40,64}$/.test(record.repoCommit));
      for (const file of fixture.manifest.files) {
        assert.equal(record.files[file.dest], sha256(fs.readFileSync(path.join(fixture.ch, file.dest))));
      }
      const fragment = substitutePlaceholders(readJson(path.join(fixture.payload, manifest.settings)), fixture.ch);
      assert.deepEqual(record.hooks, hookIdentities(fragment));
      assert.deepEqual(record.marketplaces, ['luna-local']);
      assert.equal(record.createdSentinel, true);
      assert.equal(record.createdEnv, true);
    });
    test('upgrade prunes unchanged files, keeps edited files, and removes only dropped hook identities', () => {
      const fixture = isolated('upgrade');
      install(fixture.ctx);
      const script = path.join(fixture.ch, 'scripts/example.mjs');
      atomicWrite(script, 'user edit to retired script');
      fixture.manifest.files = fixture.manifest.files.filter(file => file.kind === 'config-if-absent');
      atomicWrite(path.join(fixture.payload, 'manifest.json'), json(fixture.manifest));
      const fragmentPath = path.join(fixture.payload, fixture.manifest.settings);
      const fragment = readJson(fragmentPath);
      fragment.hooks.PreToolUse[0].hooks.pop();
      atomicWrite(fragmentPath, json(fragment));
      const settingsPath = path.join(fixture.ch, 'settings.json');
      const settings = readJson(settingsPath);
      settings.hooks.PreToolUse[1].hooks.push(foreign);
      atomicWrite(settingsPath, json(settings));
      const upgrade = winContext(fixture.options);
      install(upgrade);
      assert.equal(fs.existsSync(path.join(fixture.ch, 'bin/example.exe')), false);
      assert.equal(fs.readFileSync(script, 'utf8'), 'user edit to retired script');
      assert.ok(upgrade.warnings.some(message => message.includes('Kept locally edited')));
      const hooks = readJson(settingsPath).hooks.PreToolUse.flatMap(entry => entry.hooks);
      assert.ok(hooks.some(hook => hook.command === foreign.command));
      assert.ok(!hooks.some(hook => hook.command.endsWith(' extra')));
      assert.ok(hooks.some(hook => hook.command.endsWith(' pre')));
      assert.ok(readJson(settingsPath).hooks.PreToolUse.every(entry => entry.hooks.length > 0));
      fragment.hooks = {};
      atomicWrite(fragmentPath, json(fragment));
      install(winContext(fixture.options));
      assert.deepEqual(readJson(settingsPath).hooks.PreToolUse, [{ matcher: 'Bash', hooks: [foreign] }]);
    });
    test('user edits get timestamped backups while managed upgrades do not', () => {
      const fixture = isolated('user-edit');
      const script = path.join(fixture.ch, 'scripts/example.mjs');
      atomicWrite(script, 'before first install');
      install(fixture.ctx);
      assert.equal(fs.readFileSync(`${script}${BACKUP_SUFFIX}`, 'utf8'), 'before first install');
      atomicWrite(script, 'my local edit');
      const upgrade = winContext(fixture.options);
      install(upgrade);
      const backups = fs.readdirSync(path.dirname(script)).filter(name =>
        /^example\.mjs\.bak-luna-harness-\d{8}-\d{6}(?:-\d+)?$/.test(name));
      assert.ok(backups.some(name =>
        fs.readFileSync(path.join(path.dirname(script), name), 'utf8') === 'my local edit'));
      assert.ok(upgrade.warnings.some(message => message.startsWith('local edits saved to ')));
      const source = fixture.manifest.files[0];
      atomicWrite(path.join(fixture.payload, source.src), 'new package version');
      source.sha256 = sha256('new package version');
      atomicWrite(path.join(fixture.payload, 'manifest.json'), json(fixture.manifest));
      const before = fs.readdirSync(path.dirname(script)).filter(name => name.includes(BACKUP_SUFFIX));
      install(winContext(fixture.options));
      assert.deepEqual(fs.readdirSync(path.dirname(script)).filter(name => name.includes(BACKUP_SUFFIX)), before);
      assert.equal(fs.readFileSync(script, 'utf8'), 'new package version');
    });
    test('invalid settings fails before any directory, file, or backup changes; BOM is accepted', () => {
      const fixture = isolated('invalid-settings');
      const settingsPath = path.join(fixture.ch, 'settings.json');
      atomicWrite(settingsPath, '{ // comments are invalid\n}');
      const before = snapshot(fixture.ctx.home);
      assert.throws(() => install(fixture.ctx), /JSON|property|Unexpected/i);
      assert.deepEqual(snapshot(fixture.ctx.home), before);
      atomicWrite(settingsPath, '\uFEFF{"foreign":true}\r\n');
      install(winContext(fixture.options));
      assert.equal(readJson(settingsPath).foreign, true);
    });
    test('corrupt later payload, invalid markers, and invalid fragment fail before any write', () => {
      const fixture = isolated('validation');
      const binary = path.join(fixture.payload, fixture.manifest.files[2].src);
      const original = fs.readFileSync(binary);
      atomicWrite(binary, 'corrupt');
      assert.throws(() => install(fixture.ctx), /SHA256 mismatch/);
      assert.equal(fs.existsSync(fixture.ctx.home), false);
      atomicWrite(binary, original);
      atomicWrite(path.join(fixture.ch, 'CLAUDE.md'), `${END}\n${BEGIN}\n`);
      const before = snapshot(fixture.ctx.home);
      assert.throws(() => install(winContext(fixture.options)), /markers/);
      assert.deepEqual(snapshot(fixture.ctx.home), before);
      atomicWrite(path.join(fixture.ch, 'CLAUDE.md'), 'User text');
      atomicWrite(path.join(fixture.payload, fixture.manifest.settings), '{"hooks":{"Stop":{}}}');
      const next = snapshot(fixture.ctx.home);
      assert.throws(() => install(winContext(fixture.options)), /array/);
      assert.deepEqual(snapshot(fixture.ctx.home), next);
    });
    test('uninstall round-trip restores exact settings and CLAUDE.md bytes and foreign hooks', () => {
      const fixture = isolated('uninstall');
      const settingsPath = path.join(fixture.ch, 'settings.json');
      const mdPath = path.join(fixture.ch, 'CLAUDE.md');
      const settings = Buffer.from('\uFEFF{ "foreign": 1, "hooks": { "Stop": [{"hooks": '
        + '[{"type":"command","command":"echo foreign"}]}]}}\r\n');
      const md = Buffer.from('User instructions.\r\nNo final newline');
      atomicWrite(settingsPath, settings);
      atomicWrite(mdPath, md);
      const plugin = path.join(fixture.ch, 'plugins/test/plugin.mjs');
      atomicWrite(plugin, fixture.original.replaceAll('\n', '\r\n'));
      install(fixture.ctx);
      const installed = readJson(path.join(fixture.ch, RECORD));
      assert.equal(installed.createdEnv, true);
      const beforeDry = snapshot(fixture.ctx.home);
      const dry = winContext({ ...fixture.options, uninstall: true, dryRun: true });
      assert.equal(install(dry), 0);
      assert.deepEqual(snapshot(fixture.ctx.home), beforeDry);
      assert.equal(install(winContext({ ...fixture.options, uninstall: true })), 0);
      assert.deepEqual(fs.readFileSync(settingsPath), settings);
      assert.deepEqual(fs.readFileSync(mdPath), md);
      assert.equal(readJson(settingsPath).hooks.Stop[0].hooks[0].command, 'echo foreign');
      assert.equal(fs.readFileSync(plugin, 'utf8'), fixture.original.replaceAll('\n', '\r\n'));
      const removed = ['scripts/example.mjs', 'bin/example.exe', 'luna-harness.env', 'codex-gate-runner-off', RECORD];
      for (const file of removed) {
        assert.equal(fs.existsSync(path.join(fixture.ch, file)), false, file);
      }
      assert.equal(fs.existsSync(`${settingsPath}${BACKUP_SUFFIX}`), true);
      assert.equal(fs.existsSync(`${plugin}.orig-luna-harness`), true);
    });
    test('uninstall of a fresh home removes managed settings and CLAUDE.md; reinstall keeps ownership', () => {
      const fixture = isolated('uninstall-fresh');
      install(fixture.ctx);
      install(winContext(fixture.options));
      const record = readJson(path.join(fixture.ch, RECORD));
      assert.equal(record.createdEnv, true);
      assert.equal(record.createdSentinel, true);
      install(winContext({ ...fixture.options, uninstall: true }));
      for (const file of ['settings.json', 'CLAUDE.md', 'luna-harness.env', 'codex-gate-runner-off', RECORD]) {
        assert.equal(fs.existsSync(path.join(fixture.ch, file)), false, file);
      }
    });
    test('uninstall preserves edits, data, backups, and pre-existing env and sentinel', () => {
      const fixture = isolated('uninstall-edits');
      const env = path.join(fixture.ch, 'luna-harness.env');
      const sentinel = path.join(fixture.ch, 'codex-gate-runner-off');
      atomicWrite(env, 'LUNA_CUSTOM_CODEX_ROOT=C:\\existing\n');
      atomicWrite(sentinel, 'user sentinel');
      atomicWrite(path.join(fixture.ch, 'learning/config.json'), '{"user":1}');
      install(fixture.ctx);
      install(winContext(fixture.options));
      const record = readJson(path.join(fixture.ch, RECORD));
      assert.equal(record.createdEnv, false);
      assert.equal(record.createdSentinel, false);
      assert.equal(Object.hasOwn(record.files, 'learning/config.json'), false);
      const script = path.join(fixture.ch, 'scripts/example.mjs');
      atomicWrite(script, 'edited installed file');
      atomicWrite(path.join(fixture.ch, 'luna-run/data.json'), 'runtime data');
      atomicWrite(path.join(fixture.ch, 'learning/data.json'), 'learning data');
      const settingsPath = path.join(fixture.ch, 'settings.json');
      const settings = readJson(settingsPath);
      settings.userAfterInstall = true;
      settings.hooks.PreToolUse[0].hooks.push(foreign);
      atomicWrite(settingsPath, json(settings));
      const mdPath = path.join(fixture.ch, 'CLAUDE.md');
      atomicWrite(mdPath, `${fs.readFileSync(mdPath, 'utf8')}User after\r\n`);
      const remove = winContext({ ...fixture.options, uninstall: true });
      install(remove);
      assert.equal(fs.readFileSync(script, 'utf8'), 'edited installed file');
      assert.ok(remove.warnings.some(message => message.includes('Kept locally edited')));
      assert.equal(readJson(settingsPath).userAfterInstall, true);
      assert.deepEqual(readJson(settingsPath).hooks.PreToolUse[0].hooks, [foreign]);
      assert.equal(readJson(settingsPath).extraKnownMarketplaces['luna-local'], undefined);
      assert.equal(readJson(settingsPath).enabledPlugins['luna-panel@luna-local'], undefined);
      assert.equal(fs.readFileSync(mdPath, 'utf8'), '\nUser after\r\n');
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'user sentinel');
      assert.equal(fs.readFileSync(env, 'utf8'), 'LUNA_CUSTOM_CODEX_ROOT=C:\\existing\n');
      assert.equal(fs.readFileSync(path.join(fixture.ch, 'luna-run/data.json'), 'utf8'), 'runtime data');
      assert.equal(fs.readFileSync(path.join(fixture.ch, 'learning/data.json'), 'utf8'), 'learning data');
      assert.equal(fs.readFileSync(path.join(fixture.ch, 'learning/config.json'), 'utf8'), '{"user":1}');
    });
    test('uninstall without record or with invalid settings fails without writes', () => {
      const fixture = isolated('uninstall-invalid');
      assert.throws(() => install(winContext({ ...fixture.options, uninstall: true })), /record not found/);
      assert.equal(fs.existsSync(fixture.ctx.home), false);
      install(fixture.ctx);
      atomicWrite(path.join(fixture.ch, 'settings.json'), '{invalid');
      const before = snapshot(fixture.ctx.home);
      assert.throws(() => install(winContext({ ...fixture.options, uninstall: true })), /JSON|property|Unexpected/i);
      assert.deepEqual(snapshot(fixture.ctx.home), before);
    });
    test('recreating a missing env or sentinel on upgrade records installer ownership', () => {
      const fixture = isolated('recreated-owned-files');
      const env = path.join(fixture.ch, 'luna-harness.env');
      const sentinel = path.join(fixture.ch, 'codex-gate-runner-off');
      atomicWrite(env, 'LUNA_CUSTOM_CODEX_ROOT=C:\\existing\n');
      atomicWrite(sentinel, '');
      install(fixture.ctx);
      assert.equal(readJson(path.join(fixture.ch, RECORD)).createdEnv, false);
      assert.equal(readJson(path.join(fixture.ch, RECORD)).createdSentinel, false);
      fs.unlinkSync(env);
      fs.unlinkSync(sentinel);
      install(winContext(fixture.options));
      assert.equal(readJson(path.join(fixture.ch, RECORD)).createdEnv, true);
      assert.equal(readJson(path.join(fixture.ch, RECORD)).createdSentinel, true);
      install(winContext({ ...fixture.options, uninstall: true }));
      assert.equal(fs.existsSync(env), false);
      assert.equal(fs.existsSync(sentinel), false);
    });
    test('installer matches CRLF plugin targets and preserves CRLF when patching', () => {
      const fixture = isolated('crlf');
      const plugin = path.join(fixture.ch, 'plugins/test/plugin.mjs');
      atomicWrite(plugin, fixture.original.replaceAll('\n', '\r\n'));
      install(fixture.ctx);
      assert.equal(fs.readFileSync(plugin, 'utf8'), fixture.patched.replaceAll('\n', '\r\n'));
      assert.equal(fs.readFileSync(`${plugin}.orig-luna-harness`, 'utf8'), fixture.original.replaceAll('\n', '\r\n'));
    });
    console.log(`PASS: ${passed} tests, 0 failures`);
    return 0;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  let ctx;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(USAGE); return 0; }
    if (options.selfTest) return selfTest();
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
