/**
 * Usage: node tools/manifest-sync.mjs [--check].
 * Sync the Linux manifest and check the generated Windows payload. Run node tools/sync-windows.mjs to refresh Windows.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const shippedTestDirs = [
  'scripts/conveyor/test', 'hooks/test', 'scripts/learning/test', 'local-plugins/luna-panel/tests'
];

function shipsByDefault(relative) {
  // Ship the complete vendored plugin, including its verification corpus.
  return relative.startsWith('local-plugins/pstack/')
    || shippedTestDirs.some(dir => relative === dir || relative.startsWith(`${dir}/`))
    || !relative.split('/').some(part => part === 'test' || part === 'tests' || part.includes('.test.'));
}

export function refuseCredentialFiles(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) refuseCredentialFiles(file);
    else if (/\.local\.md$|credential|^\.env(\.|$)|^auth\.json$|\.pem$|^id_(rsa|ed25519|ecdsa)/i.test(entry.name)) {
      throw new Error(`Refusing to sync a payload containing a local credential file: ${file}`);
    } else if (entry.name === 'orchestration.json' && path.basename(root) === 'conveyor') {
      // The owner's live routing is user data; only orchestration.default.json ships.
      throw new Error(`Refusing to sync a payload containing the live routing config: ${file}`);
    }
  }
}

export function payloadFiles(root, relative = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (['__pycache__', 'node_modules', '.DS_Store'].includes(entry.name) || entry.name.includes('.bak')) return [];
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in payload: ${file}`);
    return entry.isDirectory() ? payloadFiles(file, rel) : entry.isFile() ? [rel] : [];
  });
}

export function readOptional(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

export function buildManifest(manifest, relatives, readSource, changed = () => {}) {
  const files = [];
  const listed = new Set();
  const add = (entry, bytes) => {
    const file = { ...entry, sha256: hash(bytes) };
    if (file.dest === 'conveyor/orchestration.json') file.kind = 'config-if-absent';
    if (file.dest === 'conveyor/harness-facts.json') file.kind = 'file';
    if (file.src.endsWith('.sh') || bytes.subarray(0, 2).toString() === '#!') file.executable = true;
    else delete file.executable;
    files.push(file);
    listed.add(file.src);
  };
  for (const file of manifest.files) {
    const bytes = readSource(file.src);
    if (!bytes) {
      changed(`Remove ${file.src}`);
      continue;
    }
    add(file, bytes);
    const next = files.at(-1);
    if (file.sha256 !== next.sha256) changed(`Refresh ${file.src}`);
    if (file.executable !== next.executable || (next.executable === undefined && Object.hasOwn(file, 'executable'))) {
      changed(`${next.executable ? 'Set' : 'Remove'} executable ${file.src}`);
    }
    if (file.kind !== next.kind) changed(`Update kind for ${file.dest}`);
  }
  for (const relative of [...relatives].sort()) {
    const src = `claude/${relative}`;
    if (!listed.has(src) && shipsByDefault(relative)) {
      add({ src, dest: relative, kind: 'file' }, readSource(src));
      changed(`Add ${src}`);
    }
  }
  const next = { ...manifest, files };
  for (const [source, key] of [['settings', 'settingsSha256'], ['claudeMd', 'claudeMdSha256']]) {
    next[key] = hash(readSource(manifest[source]));
    if (manifest[key] !== next[key]) changed(`Refresh ${key}`);
  }
  return next;
}

export const manifestText = manifest => `${JSON.stringify(manifest, null, 2)}\n`;

function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const payload = path.join(repo, 'payload-linux');
  const windowsPayload = path.join(repo, 'payload');
  const manifestPath = path.join(payload, 'manifest.json');
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: node tools/manifest-sync.mjs [--check]');
  const check = args.includes('--check');

  refuseCredentialFiles(payload);
  if (fs.existsSync(windowsPayload)) refuseCredentialFiles(windowsPayload);

  const original = fs.readFileSync(manifestPath, 'utf8');
  const changes = [];
  const manifest = buildManifest(JSON.parse(original), payloadFiles(path.join(payload, 'claude')),
    src => readOptional(path.join(payload, src)), change => changes.push(change));
  const next = manifestText(manifest);
  if (original !== next && !changes.length) changes.push('Normalize manifest formatting');
  for (const change of changes) console.log(change);
  if (check && original !== next) process.exitCode = 1;
  else if (original !== next) fs.writeFileSync(manifestPath, next);
  console.log(changes.length ? `${changes.length} manifest changes${check ? ' needed' : ' applied'}.`
    : 'Linux manifest is up to date.');

  if (fs.existsSync(windowsPayload)) {
    const result = spawnSync(process.execPath, [path.join(repo, 'tools/sync-windows.mjs'), '--check'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
