#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { accountPaths, codexAccounts, stamp, used, validAccountId, validateAccounts } from './conveyor/lib/codex-accounts.mjs';
import { loadConfig, providerState, updateConfig } from './conveyor/lib/orchestration.mjs';
import { home, platform } from './conveyor/lib/platform.mjs';

const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const print = (value) => console.log(JSON.stringify(value, null, 2));

async function add(id, label = id) {
  if (platform === 'win32') throw new Error('second Codex account: Linux only for now');
  const { codexHome } = accountPaths(id);
  if (id !== 'main') {
    await updateConfig(async (config) => {
      const registry = codexAccounts(config);
      const registered = registry.some((account) => account.id === id);
      const next = [...registry, { id, label }];
      if (!registered) validateAccounts(next);
      await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
      try { await fs.symlink(path.join(home(), '.codex', 'config.toml'), path.join(codexHome, 'config.toml')); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (registered) return null;
      config.codex_accounts = next;
      return `add Codex account ${id}`;
    });
  }
  console.log(`CODEX_HOME=${shellQuote(codexHome)} codex login --device-auth`);
  console.log(`CODEX_HOME=${shellQuote(codexHome)} codex login status`);
}

async function remove(id) {
  if (!validAccountId(id)) throw new Error(`invalid Codex account id: ${id}`);
  if (id === 'main') throw new Error('cannot remove the main Codex account');
  await updateConfig((config) => {
    const registry = codexAccounts(config);
    const next = registry.filter((account) => account.id !== id);
    if (next.length === registry.length) throw new Error(`unknown Codex account: ${id}`);
    config.codex_accounts = next;
    return `remove Codex account ${id}`;
  });
}

async function list(json) {
  const state = await providerState(undefined, { persist: false });
  const accounts = state.threshold.accounts.map((status) => {
    const { id } = status;
    const usage = state.usage.codexAccounts[id], mark = state.providers.codex.accounts[id];
    const window = (reading) => ({ usedPercent: used(reading), resetsAt: reading?.resetsAt ?? null });
    return {
      ...status, home: accountPaths(id).codexHome, active: id === state.threshold.active,
      mark: stamp(mark.until) > state.now ? mark : null, primary: window(usage.primary), secondary: window(usage.secondary)
    };
  });
  if (json) return print(accounts);
  for (const account of accounts) {
    const window = ({ usedPercent, resetsAt }) => `${usedPercent === null ? 'unknown' : `${usedPercent}%`} (resetsAt=${resetsAt ?? '?'})`;
    console.log(`${account.active ? '*' : ' '} ${account.id} (${account.label}) ${account.home}`);
    console.log(`  loggedIn=${account.loggedIn} exhausted=${account.exhausted} — ${account.reason}`);
    console.log(`  primary ${window(account.primary)}, secondary ${window(account.secondary)}`);
    if (account.mark) console.log(`  mark=${account.mark.reason} until ${account.mark.until}`);
  }
}

async function pick({ json, shell, account: pin }) {
  const config = await loadConfig();
  if (pin !== undefined && !codexAccounts(config).some(({ id }) => id === pin)) {
    console.error(`codex-accounts: unknown Codex account: ${pin}`);
    return 2;
  }
  // A pin was chosen by the dispatcher already: printing its paths needs no usage state, so a damaged providers.json
  // can never turn a job pinned to one account into a job on another.
  if (pin !== undefined) {
    const { codexHome, runRoot } = accountPaths(pin);
    const fields = shell
      ? { LUNA_ACCOUNT: pin, LUNA_ACCOUNT_HOME: codexHome, LUNA_ACCOUNT_RUN: runRoot, LUNA_ACCOUNT_EXHAUSTED: 0 }
      : { id: pin, codex_home: codexHome, run_root: runRoot, exhausted: 0 };
    if (json) print(fields);
    else for (const [key, value] of Object.entries(fields)) console.log(`${key}=${shell ? shellQuote(value) : value}`);
    return 0;
  }
  const state = await providerState(config);
  const { active, accounts } = state.threshold;
  let id = pin ?? active;
  if (id === null) {
    let leastUsed = Infinity;
    id = 'main';
    for (const account of accounts) {
      if (!account.loggedIn || !account.known) continue;
      const usage = state.usage.codexAccounts[account.id];
      const peak = Math.max(...config.thresholds.codex.windows.map((name) => used(usage[name]) ?? -Infinity));
      if (peak < leastUsed) {
        leastUsed = peak;
        id = account.id;
      }
    }
  }
  const { codexHome, runRoot } = accountPaths(id);
  const exhausted = Number(accounts.find((account) => account.id === id).exhausted);
  if (json) print({ id, codex_home: codexHome, run_root: runRoot, exhausted });
  else {
    const fields = shell
      ? { LUNA_ACCOUNT: id, LUNA_ACCOUNT_HOME: codexHome, LUNA_ACCOUNT_RUN: runRoot, LUNA_ACCOUNT_EXHAUSTED: exhausted }
      : { id, codex_home: codexHome, run_root: runRoot, exhausted };
    for (const [key, value] of Object.entries(fields)) console.log(`${key}=${shell ? shellQuote(value) : value}`);
  }
  return 0;
}

async function main([command, ...args]) {
  const options = {
    add: { label: { type: 'string' } },
    remove: {},
    list: { json: { type: 'boolean' } },
    pick: { json: { type: 'boolean' }, shell: { type: 'boolean' }, account: { type: 'string' } }
  };
  const usage = 'usage: codex-accounts.mjs add <id> [--label <text>] | remove <id> | list [--json] | ' +
    'pick [--json|--shell] [--account <id>]';
  if (!Object.hasOwn(options, command)) throw new Error(usage);
  const { values, positionals } = parseArgs({ args, options: options[command], allowPositionals: true });
  const takesId = command === 'add' || command === 'remove';
  if (positionals.length !== Number(takesId) || (values.json && values.shell)) throw new Error(usage);
  if (command === 'add') await add(positionals[0], values.label);
  if (command === 'remove') await remove(positionals[0]);
  if (command === 'list') await list(values.json);
  if (command === 'pick') return pick(values);
  return 0;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) {
  console.error(`codex-accounts: ${error.message}`);
  process.exitCode = 1;
}
