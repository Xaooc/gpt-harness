/**
 * Node >= 20. Usage: node install.mjs [--home <dir>] [--codex-build-root <winpath>]
 *   [--dry-run] [--check] [--no-plugin-patch] [--yes]
 * Run node install.mjs --self-test for isolated tests using a tiny temporary payload.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_SUFFIX = '.bak-luna-harness';
const BEGIN = '<!-- luna-harness:begin -->';
const END = '<!-- luna-harness:end -->';
const CHECK_TIMEOUT = 300_000;

function parseArgs(args) {
  const options = { home: os.homedir(), payload: path.join(REPO_ROOT, 'payload') };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--home' || arg === '--codex-build-root') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg === '--home' ? 'home' : 'codexBuildRoot'] = value;
    } else {
      const flags = {
        '--dry-run': 'dryRun', '--check': 'check', '--no-plugin-patch': 'noPluginPatch',
        '--yes': 'yes', '--self-test': 'selfTest',
      };
      if (!flags[arg]) throw new Error(`Unknown option: ${arg}`);
      options[flags[arg]] = true;
    }
  }
  options.home = path.resolve(options.home);
  return options;
}

function makeContext(options) {
  return {
    ...options,
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

function writeManaged(ctx, file, bytes, options = {}) {
  bytes = Buffer.from(bytes);
  const previous = readOptional(file);
  if (previous && (options.configIfAbsent || previous.equals(bytes))) {
    skip(ctx, `${file}${options.configIfAbsent ? ' (config already exists)' : ' (identical)'}`);
    return false;
  }
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
  report(ctx, process.platform === 'win32' ? 'ok' : 'warn', `Platform: ${process.platform} (Windows intended)`);
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node >= 20 is required');
  report(ctx, 'ok', `Node ${process.versions.node}`);
  ctx.bash = findBash();
  report(ctx, ctx.bash ? 'ok' : 'warn', ctx.bash ? `Git Bash: ${ctx.bash}` : 'Git Bash not found');
  const curl = findExecutable('curl');
  report(ctx, curl ? 'ok' : 'warn', curl ? `curl: ${curl}` : 'curl not found on PATH');
  // A constant shell command supports the codex.cmd shim on Windows without quoting user input.
  const codex = runCommand('codex --version', [], { shell: true, env: homeEnvironment(ctx) });
  const version = commandOutput(codex).replace(/\s+/g, ' ');
  const expected = codex.status === 0 && /\b0\.162\.1\b/.test(version);
  report(ctx, expected ? 'ok' : 'warn', codex.status === 0
    ? `Codex: ${version}${expected ? '' : ' (expected 0.162.1 for the custom build and plugin patches)'}`
    : 'codex --version failed; install Codex 0.162.1');
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
    const source = resolveInside(ctx.payload, file.src);
    const bytes = fs.readFileSync(source);
    assertHash(bytes, file.sha256, source);
    writeManaged(ctx, resolveInside(ctx.claudeHome, file.dest), bytes, {
      configIfAbsent: file.kind === 'config-if-absent',
      sha256: file.kind === 'binary' ? file.sha256 : undefined,
    });
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
    const fragment = substitutePlaceholders(readJson(fragmentPath), ctx.claudeHome);
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
  const begins = [...text.matchAll(/^<!-- luna-harness:begin -->\r?$/gm)];
  const ends = [...text.matchAll(/^<!-- luna-harness:end -->\r?$/gm)];
  if (begins.length || ends.length) {
    if (begins.length !== 1 || ends.length !== 1 || begins[0].index >= ends[0].index) {
      throw new Error('CLAUDE.md has ambiguous or incomplete luna-harness markers; repair them before installing');
    }
    const end = ends[0].index + ends[0][0].length;
    writeManaged(ctx, file, `${text.slice(0, begins[0].index)}${block}${text.slice(end)}`);
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
  const manifest = readJson(manifestPath);
  const patchRoot = path.dirname(manifestPath);
  if (!Array.isArray(manifest.roots) || !Array.isArray(manifest.files)) {
    throw new Error('Invalid plugin patch manifest');
  }
  for (const relativeRoot of manifest.roots) {
    const root = resolveInside(ctx.claudeHome, relativeRoot);
    if (!fs.existsSync(root)) {
      report(ctx, 'warn', 'codex@openai-codex not installed yet: run `/plugin install codex@openai-codex`'
        + ' in Claude Code, then re-run install.mjs');
      continue;
    }
    for (const file of manifest.files) {
      const target = resolveInside(root, file.rel);
      const bytes = readOptional(target);
      const hash = bytes === null ? null : sha256(bytes);
      if (hash === file.patchedSha256) {
        skip(ctx, `${target} already patched`);
      } else if (hash === file.origSha256) {
        const patched = fs.readFileSync(resolveInside(patchRoot, file.patched));
        assertHash(patched, file.patchedSha256, file.patched);
        writeManaged(ctx, target, patched, {
          backupSuffix: '.orig-luna-harness', sha256: file.patchedSha256,
        });
      } else {
        report(ctx, 'warn', `${target}: plugin version differs — apply manually,`
          + ' see payload/codex-plugin-patches/README.md');
      }
    }
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
      report(ctx, 'FAIL', `FAIL | ${check.label}: Git Bash unavailable`);
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
  ctx.log('Next steps: build custom Codex using codex-build/BUILD.md if needed;');
  ctx.log('  install codex@openai-codex via /plugin install codex@openai-codex, then re-run install.mjs.');
}

function install(ctx) {
  preflight(ctx);
  let checkStatus = 0;
  if (!(ctx.dryRun && ctx.check)) {
    const manifest = readJson(path.join(ctx.payload, 'manifest.json'));
    installFiles(ctx, manifest);
    installSettings(ctx, resolveInside(ctx.payload, manifest.settings));
    installClaudeMd(ctx, resolveInside(ctx.payload, manifest.claudeMd));
    installEnv(ctx);
    installSentinel(ctx);
    if (ctx.noPluginPatch) skip(ctx, 'Plugin patches disabled by --no-plugin-patch');
    else patchPlugins(ctx, resolveInside(ctx.payload, manifest.pluginPatches));
    checkCustomCodex(ctx);
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
    extraKnownMarketplaces: { luna: { source: { path: '{{CLAUDE_HOME_WIN}}\\plugins' } } },
    enabledPlugins: { 'codex@openai-codex': true },
  }));
  put(manifest.claudeMd, 'Harness instructions.\n');
  const original = 'original plugin\n';
  const patched = 'patched plugin\n';
  put('codex-plugin-patches/patched/plugin.mjs', patched);
  put('codex-plugin-patches/orig/plugin.mjs', original);
  put(manifest.pluginPatches, JSON.stringify({
    plugin: 'codex@openai-codex', version: '1.0.3', roots: ['plugins/test'],
    files: [{ rel: 'plugin.mjs', origSha256: sha256(original), patchedSha256: sha256(patched),
      patched: 'patched/plugin.mjs', orig: 'orig/plugin.mjs' }],
  }));
  put('manifest.json', JSON.stringify(manifest));
  return { payload, manifest, original, patched };
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
  const test = (name, action) => {
    action();
    passed++;
    console.log(`[ok] PASS ${name}`);
  };
  try {
    const fixture = fakePayload(temp);
    const { payload, manifest } = fixture;
    const ctx = makeContext({ home: path.join(temp, 'home with spaces'), payload, log: () => {} });
    const ch = ctx.claudeHome;
    const settingsPath = path.join(ch, 'settings.json');
    const fragmentPath = path.join(payload, manifest.settings);
    const mdSource = path.join(payload, manifest.claudeMd);
    const mdPath = path.join(ch, 'CLAUDE.md');
    const json = value => `${JSON.stringify(value, null, 2)}\n`;
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
      const missing = makeContext({ home: path.join(temp, 'missing-plugin'), payload, log: () => {} });
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
      const dry = makeContext({ home: ctx.home, payload, dryRun: true, log: () => {} });
      install(dry);
      assert.deepEqual(snapshot(temp), before);
      const missing = makeContext({ home: path.join(temp, 'absent-home'), payload, dryRun: true, log: () => {} });
      install(missing);
      assert.equal(fs.existsSync(missing.home), false);
      assert.deepEqual(snapshot(temp), before);
    });
    test('full fake-payload installs write zero files and create zero backups on second run', () => {
      const options = { home: path.join(temp, 'fresh-home'), payload, log: () => {} };
      const first = makeContext(options);
      assert.equal(install(first), 0);
      assert.ok(first.written > 0);
      const before = snapshot(first.home);
      const second = makeContext(options);
      assert.equal(install(second), 0);
      assert.equal(second.written, 0);
      assert.equal(second.backups, 0);
      assert.deepEqual(snapshot(first.home), before);
    });
    test('dry-run plus check only checks existing installation, even without payload', () => {
      const check = makeContext({ home: path.join(temp, 'no-home'), payload: 'missing', dryRun: true,
        check: true, log: () => {} });
      assert.equal(install(check), 0);
      assert.equal(fs.existsSync(check.home), false);
    });
    test('check runner isolates home, skips missing files, and propagates child failures', () => {
      const messages = [];
      const check = makeContext({ home: path.join(temp, 'check-home'), log: message => messages.push(message) });
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
    if (options.selfTest) return selfTest();
    ctx = makeContext(options);
    return install(ctx);
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    if (ctx) printSummary(ctx);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
