#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { mlaiAccounts, mlaiPaths, validateMlaiAccounts } from './conveyor/lib/mlai.mjs';
import { loadConfig, providerState, updateConfig } from './conveyor/lib/orchestration.mjs';
import { platform } from './conveyor/lib/platform.mjs';

const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const print = (value) => console.log(JSON.stringify(value, null, 2));

function signInCommands(account) {
  const { home, bin } = mlaiPaths(process.env, account);
  const prefix = [`MLAI_HOME=${shellQuote(home)}`, 'MLAI_KEYCHAIN=file', 'NODE_USE_ENV_PROXY=1'];
  if (account.proxy) prefix.push(`HTTPS_PROXY=${shellQuote(account.proxy)}`, `HTTP_PROXY=${shellQuote(account.proxy)}`);
  prefix.push('MLAI_NO_BROWSER=1');
  const env = prefix.join(' ');
  console.log(`${env} ${shellQuote(bin)} login`);
  console.log(`${env} ${shellQuote(bin)} whoami`);
}

async function add(id, { label, proxy, home } = {}) {
  if (platform === 'win32') throw new Error('second mlai account: Linux only for now');
  const entry = { id, label: label ?? id, ...(proxy ? { proxy } : {}), ...(home ? { home } : {}) };
  await updateConfig(async (config) => {
    const registry = mlaiAccounts(config);
    if (registry.some((account) => account.id === id)) {
      await fs.mkdir(mlaiPaths(process.env, registry.find((account) => account.id === id)).home,
        { recursive: true, mode: 0o700 });
      return null;
    }
    const next = [...registry, entry];
    validateMlaiAccounts(next);
    await fs.mkdir(mlaiPaths(process.env, entry).home, { recursive: true, mode: 0o700 });
    config.mlai_accounts = next;
    return `add mlai account ${id}`;
  });
  const config = await loadConfig();
  signInCommands(mlaiAccounts(config).find((account) => account.id === id));
}

async function remove(id) {
  await updateConfig((config) => {
    if (id === 'main') throw new Error('cannot remove the main mlai account');
    const registry = mlaiAccounts(config);
    const next = registry.filter((account) => account.id !== id);
    if (next.length === registry.length) throw new Error(`unknown mlai account: ${id}`);
    validateMlaiAccounts(next);
    config.mlai_accounts = next;
    return `remove mlai account ${id}`;
  });
}

async function list(json) {
  const state = await providerState(undefined, { persist: false });
  const accounts = state.mlai.accounts.map(({ id, label, home, proxy, signedIn, expiresAt, slots, mark }) => ({
    id, label, home, proxy, signedIn, expiresAt,
    slots: { used: slots.used, limit: slots.limit },
    mark
  }));
  if (json) return print(accounts);
  for (const account of accounts) {
    console.log(`${account.id} (${account.label}) ${account.home}`);
    console.log(`  proxy=${account.proxy ?? 'none'} signedIn=${account.signedIn} ` +
      `expiresAt=${account.expiresAt ?? '?'} slots=${account.slots.used}/${account.slots.limit}`);
    if (account.mark) console.log(`  mark=${account.mark.reason} until ${account.mark.until}`);
  }
}

async function main([command, ...args]) {
  const options = {
    add: { label: { type: 'string' }, proxy: { type: 'string' }, home: { type: 'string' } },
    remove: {},
    list: { json: { type: 'boolean' } }
  };
  const usage = 'usage: mlai-accounts.mjs add <id> [--label <text>] [--proxy <url>] [--home <dir>] | ' +
    'remove <id> | list [--json]';
  if (!Object.hasOwn(options, command)) throw new Error(usage);
  const { values, positionals } = parseArgs({ args, options: options[command], allowPositionals: true });
  const takesId = command === 'add' || command === 'remove';
  if (positionals.length !== Number(takesId)) throw new Error(usage);
  if (command === 'add') await add(positionals[0], values);
  if (command === 'remove') await remove(positionals[0]);
  if (command === 'list') await list(values.json);
  return 0;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) {
  console.error(`mlai-accounts: ${error.message}`);
  process.exitCode = 1;
}
