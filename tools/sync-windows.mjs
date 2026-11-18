/** Usage: node tools/sync-windows.mjs [--check]. Generate the Windows payload from payload-linux. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, manifestText, payloadFiles, readOptional, refuseCredentialFiles } from './manifest-sync.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linux = path.join(repo, 'payload-linux');
const windows = path.join(repo, 'payload');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Usage: node tools/sync-windows.mjs [--check]');
const check = args.includes('--check');

refuseCredentialFiles(linux);
refuseCredentialFiles(windows);
const exceptions = Object.keys(JSON.parse(fs.readFileSync(path.join(repo, 'tools/windows-exceptions.json'), 'utf8')));
const excepted = src => exceptions.some(entry => src === entry || (entry.endsWith('/') && src.startsWith(entry)));

const readLinux = src => readOptional(path.join(linux, src));
const readWindows = src => readOptional(path.join(windows, src));
const linuxFiles = payloadFiles(path.join(linux, 'claude'));
const windowsFiles = payloadFiles(path.join(windows, 'claude'));
const shared = new Set(linuxFiles.map(file => `claude/${file}`).filter(src => !excepted(src)));
const local = windowsFiles.filter(file => excepted(`claude/${file}`));
const stale = windowsFiles.map(file => `claude/${file}`).filter(src => !excepted(src) && !shared.has(src));
// Outside claude/ only the manifest, the generated instructions and listed exceptions may exist.
const allowedOutside = new Set(['manifest.json', 'claude-md/harness-section.md']);
const outside = payloadFiles(windows).filter(src => !src.startsWith('claude/') && !allowedOutside.has(src) && !excepted(src));

const linuxManifest = buildManifest(JSON.parse(readLinux('manifest.json')), linuxFiles, readLinux);
const current = readWindows('manifest.json');
const windowsManifest = JSON.parse(current);
const preamble = fs.readFileSync(path.join(windows, 'claude-md/windows-preamble.md'), 'utf8').trimEnd();
const instructions = fs.readFileSync(path.join(linux, linuxManifest.claudeMd), 'utf8');
const sharedStart = /^## Process: Lauren Tan's pstack is the default\b/m.exec(instructions);
if (!sharedStart) throw new Error('Missing shared process heading in the Linux instructions');
const windowsInstructions = Buffer.from(`${preamble}\n\n${instructions.slice(sharedStart.index)}`);

const expected = new Map([...shared].sort().map(src => [src, readLinux(src)]));
expected.set(windowsManifest.claudeMd, windowsInstructions);
const manifest = buildManifest({
  ...windowsManifest,
  files: [
    ...windowsManifest.files.filter(file => excepted(file.src)),
    ...linuxManifest.files.filter(file => shared.has(file.src))
  ]
}, [...local, ...[...shared].map(src => src.slice('claude/'.length))], src => expected.get(src) ?? readWindows(src));
expected.set('manifest.json', Buffer.from(manifestText(manifest)));

const changes = [...expected].filter(([src, bytes]) => {
  const installed = readWindows(src);
  return !installed || !bytes.equals(installed);
});
for (const src of outside) console.error(`Unlisted file outside claude/ (add it to tools/windows-exceptions.json or remove it): payload/${src}`);
if (outside.length) process.exitCode = 1;
if (check) {
  for (const [src] of changes) console.error(`Stale or missing: payload/${src}`);
  for (const src of stale) console.error(`Extra generated file: payload/${src}`);
  if (changes.length || stale.length) {
    console.error('Run node tools/sync-windows.mjs to refresh the Windows payload.');
    process.exitCode = 1;
  }
} else {
  for (const src of stale) fs.unlinkSync(path.join(windows, src));
  for (const [src, bytes] of changes) {
    const target = path.join(windows, src);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}
if (changes.length || stale.length) {
  console.log(`Windows payload: ${changes.length} files to update, ${stale.length} to remove${check ? ' (--check)' : ' (applied)'}.`);
} else {
  console.log('Windows payload is up to date.');
}
