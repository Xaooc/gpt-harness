/** Usage: node tools/manifest-sync.mjs [--check]. Sync the Linux payload manifest. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const payload = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../payload-linux');
const manifestPath = path.join(payload, 'manifest.json');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Usage: node tools/manifest-sync.mjs [--check]');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const executable = (src, bytes) => src.endsWith('.sh') || bytes.subarray(0, 2).toString() === '#!';
// Ship the complete vendored plugin, including its verification corpus.
const excluded = relative => !relative.startsWith('local-plugins/pstack/') && relative.split('/').some(part =>
  ['test', 'tests', '__pycache__', 'node_modules', '.DS_Store'].includes(part)
  || /\.test\.|\.bak/.test(part));

function walk(root, relative = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded(rel)) return [];
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walk(file, rel) : entry.isFile() ? [rel] : [];
  });
}

const original = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(original);
const changes = [];
const listed = new Set();
manifest.files = manifest.files.filter(file => {
  if (fs.existsSync(path.join(payload, file.src))) return true;
  changes.push(`Remove ${file.src}`);
  return false;
});
for (const file of manifest.files) {
  listed.add(file.src);
  const bytes = fs.readFileSync(path.join(payload, file.src));
  const sha256 = hash(bytes);
  if (file.sha256 !== sha256) changes.push(`Refresh ${file.src}`);
  file.sha256 = sha256;
  if (executable(file.src, bytes)) {
    if (file.executable !== true) changes.push(`Set executable ${file.src}`);
    file.executable = true;
  } else if (Object.hasOwn(file, 'executable')) {
    changes.push(`Remove executable ${file.src}`);
    delete file.executable;
  }
  if (file.dest === 'conveyor/orchestration.json' && file.kind !== 'config-if-absent') {
    file.kind = 'config-if-absent';
    changes.push(`Preserve user config ${file.dest}`);
  }
  if (file.dest === 'conveyor/harness-facts.json' && file.kind !== 'file') {
    file.kind = 'file';
    changes.push(`Manage ${file.dest}`);
  }
}
for (const relative of walk(path.join(payload, 'claude')).sort()) {
  const src = `claude/${relative}`;
  if (listed.has(src)) continue;
  const bytes = fs.readFileSync(path.join(payload, src));
  const kind = relative === 'conveyor/orchestration.json' ? 'config-if-absent' : 'file';
  const file = { src, dest: relative, kind, sha256: hash(bytes) };
  if (executable(src, bytes)) file.executable = true;
  manifest.files.push(file);
  changes.push(`Add ${src}`);
}
for (const [source, key] of [['settings', 'settingsSha256'], ['claudeMd', 'claudeMdSha256']]) {
  const sha256 = hash(fs.readFileSync(path.join(payload, manifest[source])));
  if (manifest[key] !== sha256) changes.push(`Refresh ${key}`);
  manifest[key] = sha256;
}
const next = `${JSON.stringify(manifest, null, 2)}\n`;
if (original !== next && !changes.length) changes.push('Normalize manifest formatting');
for (const change of changes) console.log(change);
if (args.includes('--check')) {
  process.exitCode = original === next ? 0 : 1;
} else if (original !== next) {
  fs.writeFileSync(manifestPath, next);
}
console.log(changes.length ? `${changes.length} manifest changes${args.includes('--check') ? ' needed' : ' applied'}.`
  : 'Linux manifest is up to date.');
