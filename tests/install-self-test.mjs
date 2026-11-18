/** Isolated installer self-tests, run through node install.mjs --self-test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function selfTest({
  REPO_ROOT, BACKUP_SUFFIX, BEGIN, END, RECORD, USAGE, parseArgs, makeContext,
  sha256, assertHash, resolveInside, atomicWrite, backupOnce, runCommand, commandOutput,
  readJson, installFiles, substitutePlaceholders, installSettings, installClaudeMd,
  installEnv, installSentinel, patchPlugins, walkFiles, runChecks, hookIdentities,
  prepareInstall, install,
}) {
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

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-harness-self-test-'));
  let passed = 0;
  let failed = 0;
  const winContext = options => makeContext({ platform: 'win32', ...options });
  const test = (name, action) => {
    try {
      action();
      passed++;
      console.log(`[ok] PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`[FAIL] ${name}: ${error.stack}`);
    }
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
      assert.equal(parseArgs(['--accept-local-drift']).acceptLocalDrift, true);
      assert.equal(parseArgs(['--owner-setup']).ownerSetup, true);
      assert.match(USAGE, /--dry-run.*--check/);
      assert.match(USAGE, /drift exits 3 before any writes/);
      assert.match(USAGE, /--owner-setup:.*Exits 4/);
    });
    test('Linux payload hashes cover installed files and both settings assets', () => {
      const linuxPayload = path.join(REPO_ROOT, 'payload-linux');
      const linuxManifest = readJson(path.join(linuxPayload, 'manifest.json'));
      const listed = new Set(linuxManifest.files.map(file => resolveInside(linuxPayload, file.src)));
      const files = walkFiles(path.join(linuxPayload, 'claude'));
      for (const file of listed) assert.ok(files.includes(file), `Missing listed file: ${file}`);
      for (const file of files.filter(file => !listed.has(file))) {
        const relative = path.relative(path.join(linuxPayload, 'claude'), file).replaceAll('\\', '/');
        assert.ok(!relative.startsWith('local-plugins/pstack/'), `Unpackaged vendored plugin file: ${relative}`);
        assert.match(relative, /(?:^|\/)(?:test|tests|__pycache__|node_modules)(?:\/|$)|\.test\.|\.bak|(?:^|\/)\.DS_Store$/,
          `Unpackaged Linux payload file: ${relative}`);
      }
      assert.ok(linuxManifest.files.some(file => file.dest === 'scripts/lib/luna-linux-test.mjs'));
      assert.equal(linuxManifest.files.find(file => file.dest === 'conveyor/harness-facts.json')?.kind, 'file');
      assert.ok(linuxManifest.files.some(file => file.dest === 'local-plugins/pstack/.claude-plugin/plugin.json'));
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
      assert.equal(settings.enabledPlugins['pstack@luna-local'], true);
      assert.equal(settings.enabledPlugins['luna-panel@luna-local'], true);
      assert.equal(fragment.extraKnownMarketplaces['luna-local'].source.path,
        `${linux.claudeHome.replaceAll('\\', '/')}/local-plugins`);
      for (const [event, entries] of Object.entries(fragment.hooks)) {
        for (const entry of entries) for (const hook of entry.hooks) {
          assert.ok(hook.command.startsWith(`"${process.execPath.replaceAll('\\', '/')}" `));
          assert.ok(hook.command.includes(`"${linux.claudeHome.replaceAll('\\', '/')}/`));
          const script = hook.command.match(/"([^"]+)"/g)[1].slice(1, -1);
          assert.ok(fs.existsSync(script), `Missing hook target: ${script}`);
          assert.ok(manifest.files.some(file =>
            resolveInside(linux.claudeHome, file.dest).replaceAll('\\', '/') === script), `Unlisted hook: ${script}`);
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
      settings.userAfterInstall = true;
      atomicWrite(path.join(linux.claudeHome, 'settings.json'), json(settings));
      const installed = snapshot(home);
      assert.equal(install(makeContext({ ...options, uninstall: true, dryRun: true })), 0);
      assert.deepEqual(snapshot(home), installed);
      assert.equal(install(makeContext({ ...options, uninstall: true })), 0);
      assert.equal(fs.readFileSync(plugin, 'utf8'), 'unpatched plugin');
      assert.equal(fs.existsSync(path.join(linux.claudeHome, RECORD)), false);
      const remaining = readJson(path.join(linux.claudeHome, 'settings.json'));
      assert.equal(remaining.userAfterInstall, true);
      assert.equal(remaining.enabledPlugins['pstack@luna-local'], undefined);
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
      assert.ok(missing.warnings.some(warning => warning.includes('codex@openai-codex not installed yet')));
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
    function withFakeExternals(name, action) {
      const fixture = isolated(name);
      const { options, manifest, ch } = fixture;
      const bin = path.join(path.dirname(options.home), 'bin');
      const callsFile = path.join(path.dirname(options.home), 'calls.jsonl');
      const externalFile = path.join(REPO_ROOT, 'external.json');
      manifest.settingsSha256 = sha256(fs.readFileSync(path.join(options.payload, manifest.settings)));
      manifest.claudeMdSha256 = sha256(fs.readFileSync(path.join(options.payload, manifest.claudeMd)));
      atomicWrite(path.join(options.payload, 'manifest.json'), json(manifest));
      for (const cli of ['claude', 'npx']) {
        const file = path.join(bin, cli);
        atomicWrite(file, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const claude = path.join(home, '.claude');
assert.equal(home, ${JSON.stringify(options.home)});
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CLAUDE_CONFIG_DIR, claude);
assert.equal(process.cwd(), home);
assert.ok(fs.existsSync(path.join(claude, 'CLAUDE.md')));
const argv = [${JSON.stringify(cli)}, ...process.argv.slice(2)];
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(argv) + '\\n');
const entries = JSON.parse(fs.readFileSync(${JSON.stringify(externalFile)}, 'utf8'));
const entry = entries.find(item => JSON.stringify(argv) ===
  JSON.stringify(item.argv.map(arg => arg.replaceAll('{{CLAUDE_HOME}}', claude))));
assert.ok(entry, JSON.stringify(argv));
if ((process.env.LUNA_TEST_EXTERNAL_FAILURES || '').split(',').includes(entry.id)) {
  console.error('simulated failure for ' + entry.id);
  process.exit(1);
}
const [probe] = entry.probe;
const target = path.join(home, probe.path);
fs.mkdirSync(path.dirname(target), { recursive: true });
if (probe.keys) {
  const registry = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
  let current = registry;
  for (const key of probe.keys.slice(0, -1)) current = current[key] ??= {};
  current[probe.keys.at(-1)] = [{}];
  fs.writeFileSync(target, JSON.stringify(registry));
} else {
  fs.writeFileSync(target, '1.4.4');
  const settingsPath = path.join(claude, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.statusLine = { type: 'command', command: 'gsd-unwanted-replacement' };
  settings.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: claude + '/hooks/gsd-fake.js' }] });
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
}
`);
        fs.chmodSync(file, 0o755);
      }
      const previousPath = process.env.PATH;
      const previousFailures = process.env.LUNA_TEST_EXTERNAL_FAILURES;
      const calls = () => fs.existsSync(callsFile)
        ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
      const messages = [];
      const run = (...args) => {
        const flags = parseArgs(['--home', options.home, '--platform', 'linux', ...args]);
        return install(makeContext({ ...flags, payload: options.payload, log: message => messages.push(message) }), () => {});
      };
      try {
        process.env.PATH = [bin, previousPath].filter(Boolean).join(path.delimiter);
        delete process.env.LUNA_TEST_EXTERNAL_FAILURES;
        const entries = readJson(externalFile).filter(entry => entry.platforms.includes('linux') && entry.argv.length);
        action({ ch, calls, run, messages, entries });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousFailures === undefined) delete process.env.LUNA_TEST_EXTERNAL_FAILURES;
        else process.env.LUNA_TEST_EXTERNAL_FAILURES = previousFailures;
      }
    }
    if (process.platform === 'win32') console.log('[skip] Owner setup fakes require Unix executable scripts');
    else {
      test('owner setup previews pending commands and installs each missing entry once', () => {
        withFakeExternals('owner setup', ({ ch, calls, run, messages, entries }) => {
          const settingsPath = path.join(ch, 'settings.json');
          const statusLine = { type: 'command', command: 'user-statusline' };
          atomicWrite(settingsPath, json({ statusLine }));
          const config = path.join(ch, 'conveyor/orchestration.json');
          atomicWrite(config, 'user configuration');
          const alreadyInstalled = 'hookify@claude-plugins-official';
          atomicWrite(path.join(ch, 'plugins/installed_plugins.json'), json({ plugins: { [alreadyInstalled]: [{}] } }));
          const pending = entries.filter(entry => entry.id !== alreadyInstalled);
          const expected = pending.map(entry => substitutePlaceholders(entry.argv, ch));
          const before = snapshot(ch);
          assert.equal(run('--owner-setup', '--dry-run'), 0);
          assert.deepEqual(snapshot(ch), before);
          for (const args of [[], ['--owner-setup', '--check']]) assert.equal(run(...args), 0);
          assert.deepEqual(calls(), []);
          for (const argv of expected) {
            const command = argv.map(arg => arg.includes(' ') ? `'${arg}'` : arg).join(' ');
            assert.equal(messages.filter(message => message.startsWith('[pending]') && message.endsWith(command)).length, 3);
          }
          assert.ok(!messages.some(message => message.startsWith(`[pending] ${alreadyInstalled}:`)));
          assert.equal(run('--owner-setup'), 0);
          assert.deepEqual(calls(), expected);
          assert.equal(run('--owner-setup'), 0);
          assert.deepEqual(calls(), expected);
          const settings = readJson(settingsPath);
          assert.deepEqual(settings.statusLine, statusLine);
          assert.ok(settings.hooks.PreToolUse.some(entry => entry.hooks.some(hook => hook.command.endsWith('/gsd-fake.js'))));
          assert.equal(fs.readFileSync(config, 'utf8'), 'user configuration');
        });
      });
      test('owner setup warns after optional failures and exits 4 if a required entry stays pending', () => {
        withFakeExternals('owner setup failure', ({ ch, calls, run, messages }) => {
          process.env.LUNA_TEST_EXTERNAL_FAILURES = 'pstack@luna-local,gsd-core';
          assert.equal(run('--owner-setup'), 4);
          assert.ok(fs.existsSync(path.join(ch, RECORD)));
          assert.ok(calls().some(argv => argv[0] === 'npx'));
          assert.ok(messages.some(message => message.includes('simulated failure for pstack@luna-local')));
          assert.ok(messages.some(message => message.includes('simulated failure for gsd-core')));
          const count = calls().length;
          process.env.LUNA_TEST_EXTERNAL_FAILURES = 'gsd-core';
          assert.equal(run('--owner-setup'), 0);
          assert.deepEqual(calls().slice(count).map(argv => argv[0] === 'npx' ? argv[0] : argv.at(-1)),
            ['pstack@luna-local', 'npx']);
        });
      });
    }
    test('managed CLAUDE.md edits refuse all modes and repeated accepted edits get distinct whole-file backups', () => {
      for (const recorded of [false, true]) {
        const f = isolated(`claude-drift-${recorded}`);
        if (recorded) assert.equal(install(f.ctx, () => {}), 0);
        const file = path.join(f.ch, 'CLAUDE.md');
        for (const edit of ['first local edit', 'second local edit']) {
          const text = `User before\n${BEGIN}\n${edit}\n${END}\nUser after\n`;
          atomicWrite(file, text);
          const before = snapshot(f.ctx.home);
          for (const mode of [{}, { dryRun: true }, { check: true }, { dryRun: true, check: true }]) {
            const attempt = winContext({ ...f.options, ...mode });
            assert.equal(install(attempt, () => {}), 3, `${edit}: must refuse managed block drift`);
            assert.deepEqual(snapshot(f.ctx.home), before);
            assert.ok(attempt.warnings.includes(`Local drift: ${file}`));
          }
          assert.equal(install(winContext({ ...f.options, acceptLocalDrift: true }), () => {}), 0);
          const backups = fs.readdirSync(f.ch).filter(name => /^CLAUDE\.md\.bak-luna-harness-\d/.test(name));
          assert.ok(backups.some(name => fs.readFileSync(path.join(f.ch, name), 'utf8') === text));
          assert.match(fs.readFileSync(file, 'utf8'), /^User before\n.*\nHarness instructions\.\n.*\nUser after\n$/);
        }
        assert.equal(fs.readdirSync(f.ch).filter(name => /^CLAUDE\.md\.bak-luna-harness-\d/.test(name)).length, 2);
        atomicWrite(file, `Outside edit\n${fs.readFileSync(file, 'utf8')}`);
        assert.equal(install(winContext(f.options), () => {}), 0);
        atomicWrite(path.join(f.payload, f.manifest.claudeMd), 'Upgraded instructions.\n');
        assert.equal(install(winContext(f.options), () => {}), 0);
        assert.match(fs.readFileSync(file, 'utf8'), /^Outside edit\nUser before\n/);
      }
    });
    test('managed hook edits refuse before writing and accepted edits get fresh settings backups', () => {
      const f = isolated('settings-drift');
      assert.equal(install(f.ctx, () => {}), 0);
      const file = path.join(f.ch, 'settings.json');
      for (const timeout of [999, 998]) {
        const settings = readJson(file);
        settings.hooks.PreToolUse[0].hooks[0].timeout = timeout;
        settings.userSetting = timeout;
        atomicWrite(file, json(settings));
        const before = snapshot(f.ctx.home);
        assert.equal(install(winContext(f.options), () => {}), 3, 'must refuse edited managed hook timeout');
        assert.deepEqual(snapshot(f.ctx.home), before);
        assert.equal(install(winContext({ ...f.options, acceptLocalDrift: true }), () => {}), 0);
        const backups = fs.readdirSync(f.ch).filter(name => /^settings\.json\.bak-luna-harness-\d/.test(name));
        assert.ok(backups.some(name => readJson(path.join(f.ch, name)).hooks.PreToolUse[0].hooks[0].timeout === timeout));
        assert.equal(readJson(file).userSetting, timeout);
      }
      const settings = readJson(file);
      settings.hooks.Stop = [{ hooks: [foreign] }];
      settings.userSetting = 'outside managed settings';
      atomicWrite(file, json(settings));
      const fragmentPath = path.join(f.payload, f.manifest.settings);
      const fragment = readJson(fragmentPath);
      fragment.hooks.PreToolUse[0].hooks[0].timeout = 21;
      atomicWrite(fragmentPath, json(fragment));
      assert.equal(install(winContext(f.options), () => {}), 0);
      assert.deepEqual(readJson(file).hooks.Stop, settings.hooks.Stop);
      assert.equal(readJson(file).userSetting, settings.userSetting);
    });
    test('manifest sync adds executable to an existing shebang entry and Linux installs it executable', () => {
      const root = path.join(temp, 'manifest-executable');
      const f = fakePayload(root);
      const payload = path.join(root, 'payload-linux');
      fs.renameSync(f.payload, payload);
      const tool = path.join(root, 'tools/manifest-sync.mjs');
      atomicWrite(tool, fs.readFileSync(path.join(REPO_ROOT, 'tools/manifest-sync.mjs')));
      atomicWrite(path.join(payload, f.manifest.files[0].src), '#!/usr/bin/env node\nexport const version = 2;\n');
      const sync = runCommand(process.execPath, [tool]);
      assert.equal(sync.status, 0, commandOutput(sync));
      const manifest = readJson(path.join(payload, 'manifest.json'));
      assert.equal(manifest.files[0].executable, true, 'existing shebang entry needs executable: true');
      const ctx = makeContext({ home: path.join(root, 'home'), platform: 'linux', payload, log: () => {} });
      assert.equal(install(ctx, () => {}), 0);
      if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(ctx.claudeHome, manifest.files[0].dest)).mode & 0o100);
    });
    test('edits after preflight stop with exit 3, preserve earlier writes, and require acceptance for backup', () => {
      for (const dest of ['bin/example.exe', 'settings.json', 'CLAUDE.md']) {
        for (const acceptLocalDrift of [false, true]) {
          const f = isolated(`late-${dest.replaceAll('/', '-')}-${acceptLocalDrift}`);
          assert.equal(install(f.ctx, () => {}), 0);
          const source = f.manifest.files[0];
          // Model an earlier upgrade's once-only backup, so the clean write before the race needs no new backup.
          backupOnce(f.ctx, path.join(f.ch, source.dest));
          atomicWrite(path.join(f.payload, source.src), 'clean upgrade\n');
          source.sha256 = sha256('clean upgrade\n');
          atomicWrite(path.join(f.payload, 'manifest.json'), json(f.manifest));
          const target = path.join(f.ch, dest);
          const lateSettings = readJson(path.join(f.ch, 'settings.json'));
          lateSettings.hooks.PreToolUse[0].hooks[0].timeout = 777;
          lateSettings.userLateEdit = true;
          const late = dest === 'settings.json' ? json(lateSettings)
            : dest === 'CLAUDE.md' ? `${BEGIN}\nlate managed edit\n${END}\n` : 'late binary edit';
          const messages = [];
          const attempt = winContext({ ...f.options, acceptLocalDrift, log: message => messages.push(message) });
          assert.equal(install(attempt, () => atomicWrite(target, late)), acceptLocalDrift ? 0 : 3,
            `${dest}: late edit must require acceptance`);
          assert.equal(fs.readFileSync(path.join(f.ch, source.dest), 'utf8'), 'clean upgrade\n');
          if (!acceptLocalDrift) {
            assert.equal(fs.readFileSync(target, 'utf8'), late);
            assert.equal(attempt.backups, 0);
            assert.ok(messages.some(message => message.includes(target) && message.includes('Local drift')));
            assert.ok(messages.some(message => message.includes('already written')));
          } else {
            const backups = fs.readdirSync(path.dirname(target)).filter(name =>
              name.startsWith(`${path.basename(target)}${BACKUP_SUFFIX}-`));
            assert.ok(backups.some(name => fs.readFileSync(path.join(path.dirname(target), name), 'utf8') === late));
          }
        }
      }
    });
    test('local drift refuses every install mode with exit 3 and no writes, with or without a record', () => {
      for (const recorded of [false, true]) {
        const fixture = isolated(`drift-refused-${recorded}`);
        if (recorded) assert.equal(install(fixture.ctx, () => {}), 0);
        const script = path.join(fixture.ch, 'scripts/example.mjs');
        const binary = path.join(fixture.ch, 'bin/example.exe');
        atomicWrite(script, 'local script edit');
        atomicWrite(binary, 'local binary edit');
        const before = snapshot(fixture.ctx.home);
        for (const mode of [{}, { dryRun: true }, { check: true }, { dryRun: true, check: true }]) {
          const messages = [];
          const attempt = winContext({ ...fixture.options, ...mode, log: message => messages.push(message) });
          assert.equal(install(attempt, () => assert.fail('Preflight must not run before drift refusal')), 3);
          assert.deepEqual(snapshot(fixture.ctx.home), before);
          assert.equal(fs.readFileSync(script, 'utf8'), 'local script edit');
          assert.equal(attempt.written, 0);
          assert.equal(attempt.backups, 0);
          for (const file of [script, binary]) assert.ok(messages.includes(`[warn] Local drift: ${file}`));
          assert.ok(messages.some(message => message.includes('three-way merge')));
        }
      }
    });
    test('accept-local-drift backs up and installs local edits, with or without a record', () => {
      for (const recorded of [false, true]) {
        const fixture = isolated(`drift-accepted-${recorded}`);
        if (recorded) assert.equal(install(fixture.ctx, () => {}), 0);
        const script = path.join(fixture.ch, 'scripts/example.mjs');
        atomicWrite(script, 'keep this local edit');
        const before = snapshot(fixture.ctx.home);
        const dry = winContext({ ...fixture.options, dryRun: true, acceptLocalDrift: true });
        assert.equal(install(dry, () => {}), 0);
        assert.deepEqual(snapshot(fixture.ctx.home), before);
        const accepted = winContext({ ...fixture.options, acceptLocalDrift: true });
        assert.equal(install(accepted, () => {}), 0);
        assert.equal(fs.readFileSync(script, 'utf8'), 'export const version = 1;\n');
        const backups = fs.readdirSync(path.dirname(script)).filter(name =>
          /^example\.mjs\.bak-luna-harness-\d{8}-\d{6}(?:-\d+)?$/.test(name));
        assert.equal(backups.length, 1);
        assert.equal(fs.readFileSync(path.join(path.dirname(script), backups[0]), 'utf8'), 'keep this local edit');
      }
    });
    test('a clean recorded install upgrades without accepting drift and existing configs never drift', () => {
      const fixture = isolated('drift-clean-upgrade');
      assert.equal(install(fixture.ctx, () => {}), 0);
      const script = path.join(fixture.ch, 'scripts/example.mjs');
      const source = fixture.manifest.files[0];
      const previous = fs.readFileSync(script);
      assert.equal(sha256(previous), readJson(path.join(fixture.ch, RECORD)).files[source.dest]);
      atomicWrite(path.join(fixture.payload, source.src), 'new clean package version');
      source.sha256 = sha256('new clean package version');
      atomicWrite(path.join(fixture.payload, 'manifest.json'), json(fixture.manifest));
      const config = path.join(fixture.ch, 'learning/config.json');
      atomicWrite(config, '{"user":true}');
      const upgrade = winContext(fixture.options);
      assert.equal(install(upgrade, () => {}), 0);
      assert.deepEqual(upgrade.prepared.driftedFiles, []);
      assert.equal(fs.readFileSync(script, 'utf8'), 'new clean package version');
      assert.equal(fs.readFileSync(config, 'utf8'), '{"user":true}');
      assert.ok(!upgrade.warnings.some(message => message.startsWith('local edits saved to ')));
      assert.ok(!fs.readdirSync(path.dirname(script)).some(name => /bak-luna-harness-\d/.test(name)));
    });
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
      fixture.ctx.acceptLocalDrift = true;
      install(fixture.ctx);
      assert.equal(fs.readFileSync(`${script}${BACKUP_SUFFIX}`, 'utf8'), 'before first install');
      atomicWrite(script, 'my local edit');
      const upgrade = winContext({ ...fixture.options, acceptLocalDrift: true });
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
    console.log(`${failed ? 'FAIL' : 'PASS'}: ${passed} tests, ${failed} failures`);
    return failed ? 1 : 0;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

