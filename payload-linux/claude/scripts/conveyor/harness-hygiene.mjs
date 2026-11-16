#!/usr/bin/env node
// Read-only checks of installed harness files, package hashes and documented claims.
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const severities = ['high', 'medium', 'low'];
const bundledFacts = fileURLToPath(new URL('../../conveyor/harness-facts.json', import.meta.url));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const singleLine = (text) => String(text).replace(/[\r\n\t]+/g, ' ');
const excluded = (name) => /\.bak.*$|\.(?:prev|next)$/.test(name)
  || ['__pycache__', '.git', 'node_modules', 'test', 'tests', 'fixtures'].includes(name);

function* filesUnder(directory, seen = new Set()) {
  if (!fs.existsSync(directory)) return;
  const real = fs.realpathSync(directory);
  if (seen.has(real)) return;
  seen.add(real);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const stat = entry.isSymbolicLink() ? fs.statSync(file) : entry;
    if (stat.isDirectory()) yield* filesUnder(file, seen);
    else if (stat.isFile()) yield file;
  }
}

function locations() {
  const claude = path.resolve(process.env.CLAUDE_HOME_DIR || path.join(homedir(), '.claude'));
  const conveyor = path.resolve(process.env.CONVEYOR_HOME || path.join(claude, 'conveyor'));
  const config = (name, fallback) => [path.join(conveyor, name), path.join(claude, 'conveyor', name), fallback]
    .find((file) => file && fs.existsSync(file)) || path.join(claude, 'conveyor', name);
  const expand = (file) => {
    const value = file.replace(/^(?:~|\$HOME|\$\{HOME\})\/\.claude(?=\/|$)/, () => claude)
      .replace(/^\$(?:CLAUDE_HOME_DIR|\{CLAUDE_HOME_DIR\})(?=\/|$)/, () => claude)
      .replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => homedir());
    return path.resolve(claude, value);
  };
  const display = (file) => file.replace(path.join(homedir(), '.claude'), '~/.claude');
  return { claude, conveyor, config, expand, display, reports: path.join(conveyor, 'hygiene') };
}

function packageSync(repo, paths, add) {
  if (!fs.existsSync(repo)) {
    add('package-sync-skipped', 'low', repo, 'Repository missing; package sync was skipped.',
      'Set --repo or HARNESS_REPO to the harness checkout.');
    return;
  }
  const payload = path.join(repo, 'payload-linux');
  const manifestFile = path.join(payload, 'manifest.json');
  const manifest = json(manifestFile);
  const listed = new Set(manifest.files.map((entry) => path.resolve(paths.claude, entry.dest)));
  for (const entry of manifest.files.filter((item) => item.kind === 'file')) {
    const source = path.join(payload, entry.src), installed = path.join(paths.claude, entry.dest);
    let digest;
    try { digest = hash(source); }
    catch (error) {
      add('manifest-stale', 'high', source, `Payload file cannot be read (${error.code}).`,
        'Restore the payload file and review its manifest hash.');
      continue;
    }
    if (digest !== entry.sha256) {
      add('manifest-stale', 'high', manifestFile, `SHA256 differs for ${entry.src}.`,
        'Review the payload change before refreshing the manifest hash.');
    }
    try {
      if (hash(installed) === digest) continue;
      const difference = fs.statSync(installed).mtimeMs - fs.statSync(source).mtimeMs;
      const newer = difference > 0 ? 'installed file is newer' : difference < 0 ? 'payload file is newer' : 'mtimes are equal';
      add('installed-drift', 'medium', installed, `Contents differ from the payload; ${newer}.`,
        'Compare both versions and choose which to keep.');
    } catch (error) {
      add('installed-drift', 'medium', installed, `Installed file is missing or unreadable (${error.code}).`,
        'Review whether this payload file should be installed.');
    }
  }
  for (const area of ['hooks', 'scripts', 'skills']) {
    for (const file of filesUnder(path.join(paths.claude, area))) {
      // Script files and skill entry points are harness candidates; arbitrary skill assets are not.
      if (listed.has(file) || !(/\.(?:[cm]?js|py|sh|bash)$/.test(file) || path.basename(file) === 'SKILL.md')) continue;
      add('unpackaged', 'low', file, 'Harness file is not listed in the package manifest.',
        'Review whether it belongs in the package.');
    }
  }
}

function commandWords(command) {
  return [...command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;|&<>]+)/g)]
    .map((match) => (match[1] ?? match[2] ?? match[3]).replace(/\\(["\\ ])/g, '$1'));
}

function hooks(paths, add) {
  const settings = path.join(paths.claude, 'settings.json');
  for (const [event, groups] of Object.entries(json(settings).hooks || {})) {
    const seen = new Map();
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type !== 'command' || typeof hook.command !== 'string') continue;
        const command = hook.command.trim(), count = seen.get(command) || 0;
        seen.set(command, count + 1);
        if (count === 1) {
          add('duplicate-hook', 'medium', `${settings} (${event})`, `Command is registered more than once: ${command}`,
            'Review and remove the redundant registration.');
        }
        if (count) continue;
        const words = commandWords(command);
        // Shell -c wrappers contain another command string, rather than a literal script path.
        for (let index = 0; index < words.length; index++) {
          if (['-c', '-lc'].includes(words[index - 1])) words.splice(index, 1, ...commandWords(words[index]));
        }
        const scripts = new Set(words.filter((word) => /\.(?:[cm]?js|py|sh|bash)$/.test(word)
          || /^(?:~|\$HOME|\$\{HOME\})\/\.claude\//.test(word)));
        for (const script of scripts) {
          const file = paths.expand(script);
          try {
            fs.accessSync(file, fs.constants.R_OK);
            if (!fs.statSync(file).isFile()) throw new Error('not a file');
          } catch {
            add('dead-hook', 'high', `${settings} (${event})`, `Hook script is missing or unreadable: ${paths.display(file)}`,
              'Restore the script or review the hook registration.');
          }
        }
      }
    }
  }
}

function facts(config, paths, add) {
  for (const fact of Array.isArray(config) ? config : config.facts || []) {
    const doc = paths.expand(fact.doc), source = paths.expand(fact.source);
    try {
      if (fact.compare !== 'equal') throw new Error('unsupported comparison');
      const claim = new RegExp(fact.docPattern, 'm').exec(fs.readFileSync(doc, 'utf8'));
      const actual = new RegExp(fact.sourcePattern, 'm').exec(fs.readFileSync(source, 'utf8'));
      if (claim?.length !== 2 || actual?.length !== 2 || claim[1] === undefined || actual[1] === undefined) {
        throw new Error('each pattern must match with exactly one capture');
      }
      if (claim[1] !== actual[1]) {
        add('fact-mismatch', 'high', doc, `${fact.id}: prose says ${claim[1]}, source says ${actual[1]} (${source}).`,
          'Review the claim against the implementation and update the outdated side.');
      }
    } catch (error) {
      add('fact-mismatch', 'medium', doc, `${fact.id}: claim could not be verified (${error.message}).`,
        'Review the fact paths and capture patterns.');
    }
  }
}

function skillFrontmatter(text) {
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1];
  if (!frontmatter) return false;
  const lines = frontmatter.split(/\r?\n/);
  return ['name', 'description'].every((key) => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index < 0) return false;
    const value = lines[index].slice(key.length + 1).trim();
    if (/^[|>][+-]?(?:[1-9])?(?:\s+#.*)?$/.test(value)) {
      return /^\s+\S/.test(lines.slice(index + 1).find((line) => line.trim()) || '');
    }
    if (value.startsWith('"') || value.startsWith("'")) {
      return new RegExp(`^${value[0]}.+${value[0]}(?:\\s+#.*)?$`).test(value);
    }
    return Boolean(value) && !/^(?:#|null$|~$|[\[\]{}])/.test(value);
  });
}

function prose(paths, add, allowed) {
  const docs = [path.join(paths.claude, 'CLAUDE.md'),
    ...[...filesUnder(path.join(paths.claude, 'skills'))].filter((file) => path.basename(file) === 'SKILL.md')];
  for (const doc of docs) {
    const text = fs.readFileSync(doc, 'utf8');
    if (path.basename(doc) === 'SKILL.md' && !skillFrontmatter(text)) {
      add('skill-frontmatter', 'medium', doc, 'YAML frontmatter needs nonempty name and description fields.',
        'Add or repair the skill frontmatter.');
    }
    const seenPaths = new Set(), seenModels = new Set();
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const where = `${doc}:${index + 1}`;
      for (const match of line.matchAll(/~\/\.claude\/[^\s`"'()\[\],;!?]*/g)) {
        const file = match[0].replace(/[.:]+$/, '');
        if (/[<*{]/.test(file) || seenPaths.has(file)) continue;
        seenPaths.add(file);
        if (!fs.existsSync(paths.expand(file))) {
          add('missing-path', 'medium', where, `Documented path does not exist: ${file}`,
            'Review the path and update the prose or restore the intended file.');
        }
      }
      if (!allowed) continue;
      for (const match of line.matchAll(/\b(?:gpt-\d[\w.-]*|gemini-[\w.-]+|claude-[\w.-]+)/g)) {
        const model = match[0].replace(/\.+$/, '');
        if (allowed.has(model) || seenModels.has(model)) continue;
        seenModels.add(model);
        add('retired-model', 'medium', where, `Model is absent from the orchestration catalog: ${model}`,
          'Review the model reference or explicitly allow an intentional historical mention.');
      }
    }
  }
}

function atomicWrite(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function counts(findings) {
  return Object.fromEntries(severities.map((severity) => [severity, findings.filter((item) => item.severity === severity).length]));
}

function textReport(report) {
  const { high, medium, low } = report.counts;
  const lines = [`Harness hygiene: ${report.findings.length} findings (${high} high, ${medium} medium, ${low} low).`];
  for (const severity of severities) {
    const items = report.findings.filter((finding) => finding.severity === severity);
    if (!items.length) continue;
    lines.push('', `${severity.toUpperCase()} (${items.length})`);
    for (const item of items) lines.push(`[${item.check}] ${item.where}: ${item.detail} Suggestion: ${item.suggestion}`);
  }
  return lines.join('\n');
}

function run(options) {
  const paths = locations(), findings = [];
  const add = (check, severity, where, detail, suggestion) => findings.push({
    check, severity, where: paths.display(singleLine(where)), detail: singleLine(detail), suggestion: singleLine(suggestion)
  });
  const attempt = (check, where, action) => {
    try { return action(); }
    catch (error) {
      add('check-unavailable', 'medium', where, `${check} could not run (${error.message}).`,
        'Review the input file and rerun the checker.');
    }
  };
  attempt('package sync', options.repo, () => packageSync(options.repo, paths, add));
  attempt('hooks', path.join(paths.claude, 'settings.json'), () => hooks(paths, add));
  const factsFile = paths.config('harness-facts.json', bundledFacts);
  const config = attempt('facts configuration', factsFile, () => json(factsFile));
  if (config) attempt('facts', factsFile, () => facts(config, paths, add));
  const catalogFile = paths.config('orchestration.json');
  const allowed = attempt('model catalog', catalogFile, () => {
    const catalog = json(catalogFile).catalog;
    const models = Object.values(catalog).flat().map((entry) => entry.model);
    return new Set([...models, ...(config?.retiredModels?.allow || [])]);
  });
  attempt('prose and skills', paths.claude, () => prose(paths, add, allowed));
  findings.sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity)
    || a.check.localeCompare(b.check) || a.where.localeCompare(b.where));
  const report = { at: new Date().toISOString(), findings, counts: counts(findings) };
  const reportFile = path.join(paths.reports, `harness-${report.at.slice(0, 10)}.md`);
  try {
    fs.mkdirSync(paths.reports, { recursive: true, mode: 0o700 });
    atomicWrite(reportFile, `# Harness hygiene — ${report.at}\n\n${textReport(report)}\n`);
    atomicWrite(path.join(paths.reports, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    add('report-write', 'medium', paths.reports, `Report could not be saved (${error.message}).`,
      'Review report directory permissions.');
    report.counts = counts(findings);
  }
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${textReport(report)}\n\nReport: ${paths.display(reportFile)}\n`);
  return options.failOn === 'high' && report.counts.high > 0 ? 1 : 0;
}

function main(args) {
  if (args.shift() !== 'run') throw new Error('Usage: harness-hygiene.mjs run [--json] [--repo <path>] [--fail-on high]');
  const options = { repo: process.env.HARNESS_REPO || path.join(homedir(), 'dev', 'gpt-harness') };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') options.json = true;
    else if (arg === '--repo' && args[0]) options.repo = args.shift();
    else if (arg === '--fail-on' && args[0] === 'high') options.failOn = args.shift();
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  options.repo = path.resolve(options.repo.replace(/^~(?=\/|$)/, () => homedir()));
  return run(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`harness-hygiene: ${singleLine(error.message)}\n`); }
}
