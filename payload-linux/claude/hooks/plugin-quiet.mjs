#!/usr/bin/env node
// SessionStart: keep installed process plugins from imposing their process (user decision 2026-11-16: pstack is the
// default; superpowers stays installed for explicit use). Removes only the SessionStart registration of the listed
// plugins in every cached version, keeping their skills. The original hooks.json is kept once as hooks.json.orig.
// A plugin update brings the hook back; the next session start removes it again. Prints nothing; always exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.CLAUDE_HOME_DIR || path.join(os.homedir(), '.claude');
const QUIET = [path.join(home, 'plugins', 'cache', 'superpowers-marketplace', 'superpowers')];
const log = path.join(home, 'conveyor', 'plugin-quiet.log');

function quiet(file) {
  const text = fs.readFileSync(file, 'utf8');
  const config = JSON.parse(text);
  if (!config?.hooks?.SessionStart) return false;
  if (!fs.existsSync(`${file}.orig`)) fs.writeFileSync(`${file}.orig`, text);
  delete config.hooks.SessionStart;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return true;
}

try {
  for (const root of QUIET) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      const file = path.join(root, version, 'hooks', 'hooks.json');
      try {
        if (fs.existsSync(file) && quiet(file)) {
          fs.mkdirSync(path.dirname(log), { recursive: true });
          fs.appendFileSync(log, `${new Date().toISOString()} removed SessionStart from ${file}\n`);
        }
      } catch {}
    }
  }
} catch {}
process.exit(0);
