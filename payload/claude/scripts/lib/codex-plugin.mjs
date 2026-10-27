// Use the installed cache copy, matching the plugin hooks' state and APIs after fresh installs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function codexPluginRoot(home = os.homedir()) {
  const cache = path.join(home, '.claude', 'plugins', 'cache', 'openai-codex', 'codex');
  const candidates = [];
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), 'utf8'));
    for (const record of installed.plugins?.['codex@openai-codex'] || []) {
      if (typeof record.installPath === 'string') {
        const root = path.resolve(record.installPath);
        const parent = path.dirname(root);
        const matches = process.platform === 'win32' ? parent.toLowerCase() === cache.toLowerCase() : parent === cache;
        if (matches) candidates.push(root);
      }
    }
  } catch {}
  try {
    const versions = fs.readdirSync(cache).map((name) => path.join(cache, name))
      .filter((file) => fs.statSync(file).isDirectory())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    candidates.push(...versions);
  } catch {}
  return candidates.find((root) => fs.existsSync(path.join(root, 'scripts', 'lib', 'state.mjs')) &&
    fs.existsSync(path.join(root, 'scripts', 'stop-review-gate-hook.mjs'))) || null;
}
