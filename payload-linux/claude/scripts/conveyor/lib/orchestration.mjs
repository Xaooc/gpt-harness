import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lockOwnerAlive, lockOwnerStart } from './platform.mjs';
import { accountPaths, codexAccounts, loggedIn, selectAccount, stamp, validateAccounts } from './codex-accounts.mjs';

const providers = ['codex', 'gemini', 'claude'];
const reasons = ['quota', 'region', 'auth', 'start'];
const defaultFile = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function paths() {
  const home = path.resolve(process.env.CONVEYOR_HOME || path.join(homedir(), '.claude', 'conveyor'));
  return {
    home,
    config: path.join(home, 'orchestration.json'),
    journal: path.join(home, 'orchestration.log.jsonl'),
    providers: path.join(home, 'providers.json'),
    switches: path.join(home, 'switches.jsonl'),
    run: path.resolve(process.env.LUNA_RUN_DIR || path.join(homedir(), '.claude', 'luna-run'))
  };
}

export function wrapperPath(provider) {
  if (provider === 'codex') {
    return path.resolve(process.env.CONVEYOR_LUNA_SH || path.join(homedir(), '.claude/scripts/luna.sh'));
  }
  if (provider === 'gemini') {
    return path.resolve(process.env.CONVEYOR_GEM_SH || path.join(homedir(), '.claude/scripts/gem.sh'));
  }
  throw new Error(`No shell wrapper for ${provider}`);
}

function keys(value, required, label, optional = []) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`unknown ${label === 'config' ? 'top-level' : label} key: ${key}`);
    }
  }
  for (const key of required) {
    if (!own(value, key)) throw new Error(`${label}.${key} is required`);
  }
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace or control characters`);
  }
}

function modelName(value, label) {
  text(value, label);
  if (/^gpt-6-astra$/i.test(value)) throw new Error(`${label}: gpt-6-astra is forbidden by user rule`);
}

function nonemptyArray(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a non-empty array`);
}

function range(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

function validateTiers(tiers, catalog, label, partial = false, knownTiers = tiers) {
  if (!object(tiers) || (!partial && !Object.keys(tiers).length)) {
    throw new Error(`${label} must be a non-empty object`);
  }
  for (const [tier, chain] of Object.entries(tiers)) {
    text(tier, `${label} tier name`);
    if (partial && !own(knownTiers, tier)) throw new Error(`${label}: unknown tier ${tier}`);
    nonemptyArray(chain, `${label}.${tier}`);
    for (const [index, entry] of chain.entries()) {
      const where = `${label}.${tier}.${index}`;
      keys(entry, ['provider', 'model', 'effort'], where);
      if (!providers.includes(entry.provider)) throw new Error(`${where}: unknown provider ${entry.provider}`);
      modelName(entry.model, `${where}.model`);
      const model = catalog[entry.provider].find((candidate) => candidate.model === entry.model);
      if (!model) throw new Error(`${where}: model ${entry.provider}/${entry.model} is not in catalog`);
      if (!model.efforts.includes(entry.effort)) {
        throw new Error(`${where}: effort ${entry.effort} is not in catalog for ${entry.provider}/${entry.model}`);
      }
    }
  }
}

export function validateConfig(config) {
  const required = ['version', 'tiers', 'panels', 'catalog', 'thresholds', 'unavailable_ttl_s', 'roles', 'presets'];
  keys(config, required, 'config', ['codex_accounts']);
  if (own(config, 'codex_accounts')) validateAccounts(config.codex_accounts);
  if (config.version !== 1) throw new Error('version must be 1');
  if (!object(config.catalog)) throw new Error('catalog must be an object');
  for (const provider of Object.keys(config.catalog)) {
    if (!providers.includes(provider)) throw new Error(`catalog: unknown provider ${provider}`);
  }
  for (const provider of providers) {
    nonemptyArray(config.catalog[provider], `catalog.${provider}`);
    const seen = new Set();
    for (const entry of config.catalog[provider]) {
      keys(entry, ['model', 'efforts'], `catalog.${provider} entry`);
      modelName(entry.model, `catalog.${provider}.model`);
      if (seen.has(entry.model)) throw new Error(`catalog.${provider}: duplicate model ${entry.model}`);
      seen.add(entry.model);
      nonemptyArray(entry.efforts, `catalog.${provider}.${entry.model}.efforts`);
      for (const effort of entry.efforts) text(effort, 'catalog effort');
      if (new Set(entry.efforts).size !== entry.efforts.length) throw new Error('catalog efforts must be unique');
    }
  }
  validateTiers(config.tiers, config.catalog, 'tiers');
  validateTiers(config.panels, config.catalog, 'panels');
  keys(config.thresholds, ['codex'], 'thresholds');
  const threshold = config.thresholds.codex;
  keys(threshold, ['switch_percent', 'windows', 'hysteresis_percent'], 'thresholds.codex');
  range(threshold.switch_percent, 1, 100, 'switch_percent');
  range(threshold.hysteresis_percent, 0, 50, 'hysteresis_percent');
  nonemptyArray(threshold.windows, 'thresholds.codex.windows');
  if (threshold.windows.some((window) => !['primary', 'secondary'].includes(window)) ||
      new Set(threshold.windows).size !== threshold.windows.length) {
    throw new Error('thresholds.codex.windows must contain unique primary/secondary window names');
  }
  keys(config.unavailable_ttl_s, reasons, 'unavailable_ttl_s');
  for (const [reason, ttl] of Object.entries(config.unavailable_ttl_s)) {
    if (!Number.isSafeInteger(ttl) || ttl < 0) {
      throw new Error(`unavailable_ttl_s.${reason} must be a non-negative integer`);
    }
  }
  if (!object(config.roles)) throw new Error('roles must be an object');
  for (const [role, target] of Object.entries(config.roles)) {
    text(role, 'role name');
    const match = typeof target === 'string' && /^(tier|panel):(.+)$/.exec(target);
    if (!match) throw new Error(`roles.${role}: expected tier:<name> or panel:<name>`);
    const [, kind, name] = match;
    if (!own(kind === 'tier' ? config.tiers : config.panels, name)) {
      throw new Error(`roles.${role}: unknown ${kind} ${name}`);
    }
  }
  if (!object(config.presets)) throw new Error('presets must be an object');
  for (const [name, preset] of Object.entries(config.presets)) {
    text(name, 'preset name');
    keys(preset, ['label', 'tiers'], `presets.${name}`);
    text(preset.label, `presets.${name}.label`);
    validateTiers(preset.tiers, config.catalog, `presets.${name}.tiers`, true, config.tiers);
  }
  return config;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

async function optionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return null; }
}

export async function loadConfig() {
  return (await loadConfigWithSource()).config;
}

export async function loadConfigWithSource() {
  const userConfig = await readJson(paths().config, undefined);
  if (userConfig !== undefined) return { config: validateConfig(userConfig), source: 'user' };
  const config = JSON.parse(await fs.readFile(defaultFile, 'utf8'));
  return { config: validateConfig(config), source: 'default' };
}

export async function writeTextAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } finally {
    if (handle) await handle.close();
    await fs.rm(temp, { force: true });
  }
}

export async function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function reclaimLock(lock) {
  let owner, stat;
  try {
    stat = await fs.stat(lock);
    owner = await optionalJson(lock);
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (lockOwnerAlive(owner?.pid, owner?.pid_start)) return;
  // A new owner needs time to populate a freshly created lock file.
  if (!owner?.pid && Date.now() - stat.mtimeMs < 10_000) return;
  const stale = `${lock}.${randomUUID()}.stale`;
  try { await fs.rename(lock, stale); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const moved = await fs.stat(stale);
    if (moved.ino !== stat.ino || moved.dev !== stat.dev) {
      // Restore a successor without overwriting another owner's lock.
      await fs.link(stale, lock);
    }
  } finally { await fs.unlink(stale); }
}

export async function withLock(file, work) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  const owner = { pid: process.pid, pid_start: lockOwnerStart(), token: randomUUID() };
  let handle;
  while (!handle) {
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await reclaimLock(lock);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lock}`);
      await pause(25);
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    return await work();
  }
  finally {
    await handle.close();
    if ((await optionalJson(lock))?.token === owner.token) await fs.unlink(lock);
  }
}

function configDiff(oldValue, newValue, prefix = '', diff = Object.create(null)) {
  if (isDeepStrictEqual(oldValue, newValue)) return diff;
  if ((object(oldValue) && object(newValue)) || (Array.isArray(oldValue) && Array.isArray(newValue))) {
    for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
      configDiff(oldValue[key], newValue[key], prefix ? `${prefix}.${key}` : key, diff);
    }
  } else diff[prefix] = [oldValue ?? null, newValue ?? null];
  return diff;
}

async function saveUnlocked(config, { actor, note }) {
  if (!['panel', 'cli'].includes(actor)) throw new Error('actor must be panel or cli');
  if (typeof note !== 'string') throw new Error('note must be a string');
  validateConfig(config);
  const previous = await loadConfig();
  const entry = { id: randomUUID(), actor, note, diff: configDiff(previous, config) };
  const journal = (status, extra = {}) => fs.appendFile(paths().journal, `${JSON.stringify({
    ...entry, at: new Date().toISOString(), status, ...extra
  })}\n`, { mode: 0o600 });
  try {
    await journal('applying', { before: previous });
    await writeJsonAtomic(paths().config, config);
    await journal('applied');
  } catch (error) {
    try { await journal('failed', { error: error.message }); } catch {}
    throw error;
  }
  try { await renderRoles(); }
  catch (error) {
    try { await journal('roles-failed', { error: error.message }); } catch {}
  }
  return config;
}

export async function saveConfig(config, options = {}) {
  const copy = structuredClone(validateConfig(config));
  return withLock(paths().config, () => saveUnlocked(copy, options));
}

/** Loads, changes and saves the config under one lock, so a save made by another process in between is never
 *  overwritten with an older copy. `change` mutates the config and returns a note, or null to write nothing. */
export async function updateConfig(change, { actor = 'cli' } = {}) {
  return withLock(paths().config, async () => {
    const config = await loadConfig();
    const note = await change(config);
    if (note === null) return null;
    await saveUnlocked(config, { actor, note });
    return note;
  });
}

export async function applyPreset(name, { actor = 'cli', note = `preset ${name}` } = {}) {
  return withLock(paths().config, async () => {
    const config = await loadConfig();
    if (!own(config.presets, name)) throw new Error(`unknown preset: ${name}`);
    for (const [tier, chain] of Object.entries(config.presets[name].tiers)) {
      config.tiers[tier] = structuredClone(chain);
    }
    return saveUnlocked(config, { actor, note });
  });
}

async function readProviders() {
  const marks = await readJson(paths().providers, {});
  if (!object(marks) || Object.values(marks).some((entry) => !object(entry))) {
    throw new Error('providers.json must be an object of provider marks');
  }
  return marks;
}

function codexMarks(provider = {}) {
  const state = { ...provider, accounts: { ...provider.accounts } };
  // Only pre-registry quota and auth marks implied main. Explicit provider marks can still coexist with account marks.
  if (!own(provider, 'accounts') && ['quota', 'auth'].includes(provider.reason)) {
    const { until, reason, note, at } = provider;
    state.accounts.main = { until, reason, note, at };
    for (const key of ['until', 'reason', 'note', 'at']) delete state[key];
  }
  if (typeof provider.switched === 'boolean') {
    state.accounts.main = { switched: provider.switched, ...state.accounts.main };
    delete state.switched;
  }
  return state;
}

export async function markUnavailable(provider, reason, note, { account, config, now = Date.now() } = {}) {
  if (!providers.includes(provider)) throw new Error(`unknown provider: ${provider}`);
  if (!reasons.includes(reason)) throw new Error(`unknown unavailable reason: ${reason}`);
  config ??= await loadConfig();
  if (account !== undefined && (provider !== 'codex' || !['quota', 'auth'].includes(reason) ||
      !codexAccounts(config).some(({ id }) => id === account))) {
    throw new Error(`invalid unavailable mark for ${provider} account ${account}: ${reason}`);
  }
  return withLock(paths().providers, async () => {
    const marks = await readProviders();
    if (provider === 'codex') marks.codex = codexMarks(marks.codex);
    const mark = {
      until: new Date(now + config.unavailable_ttl_s[reason] * 1000).toISOString(),
      reason, note, at: new Date(now).toISOString()
    };
    if (account === undefined) marks[provider] = { ...marks[provider], ...mark };
    else marks.codex.accounts[account] = {
      switched: false, ...(own(marks.codex.accounts, account) ? marks.codex.accounts[account] : {}), ...mark
    };
    await writeJsonAtomic(paths().providers, marks);
    return account === undefined ? marks[provider] : marks.codex.accounts[account];
  });
}

async function codexUsage(id, now, directories) {
  const daemon = directories?.daemon;
  const root = daemon ? (id === 'main' ? daemon : path.join(daemon, 'accounts', id)) : accountPaths(id).runRoot;
  const roots = new Set([root]);
  // Preserve the original LUNA_RUN_DIR lookup for main.
  if (id === 'main') roots.add(directories?.run ?? paths().run);
  const files = ['codex-limits.json', 'daemon-net/codex-limits.json', 'codex-limits.probe.json'];
  const candidates = await Promise.all([...roots].flatMap((root) => files.map((file) => optionalJson(path.join(root, file)))));
  const limits = candidates.filter((value) => object(value) && Number.isFinite(stamp(value.at)))
    .sort((a, b) => stamp(b.at) - stamp(a.at))[0];
  if (!limits) return { known: false, ageS: null, stale: false, primary: null, secondary: null };
  const ageS = Math.max(0, (now - stamp(limits.at)) / 1000);
  return { ...limits, ageS, stale: ageS > 1800, known: ageS <= 1800 };
}

export function codexLimitsSnapshot(state) {
  const active = state.threshold.active;
  const codexAccounts = state.threshold.accounts.map(({ id, label, loggedIn, exhausted, known, reason }) => {
    const { until, reason: markReason } = state.providers.codex.accounts[id];
    const { known: _known, stale: _stale, loggedIn: _loggedIn, ...limits } = state.usage.codexAccounts[id];
    const mark = ['quota', 'auth'].includes(markReason) && stamp(until) > state.now ? { reason: markReason, until } : null;
    return { id, label, active: id === active, loggedIn, exhausted, known, reason, mark, limits: limits.ageS === null ? null : limits };
  });
  return { codexAccounts, codexLimits: codexAccounts.find(({ id }) => id === (active ?? 'main'))?.limits ?? null };
}

async function collectorClaudeLimits(run, now) {
  // The collector publishes under the same run directory (LUNA_RUN_DIR, default ~/.claude/luna-run): reading the real
  // home as well would make an isolated run (tests, a second run root) see this machine's live limits.
  const roots = new Set([run]);
  if (process.env.CLAUDE_HOME_DIR) roots.add(path.resolve(process.env.CLAUDE_HOME_DIR, 'luna-run'));
  const snapshots = await Promise.all([...roots].map((root) => optionalJson(path.join(root, 'collector', 'snapshot.json'))));
  const latest = new Map();
  for (const snapshot of snapshots) {
    const at = stamp(snapshot?.at);
    if (!Number.isFinite(at) || now - at > 600_000 || !Array.isArray(snapshot.claudeLimits)) continue;
    for (const limit of snapshot.claudeLimits) {
      if (!object(limit) || typeof limit.kind !== 'string' || !Number.isFinite(limit.percentUsed)) continue;
      if (limit.resetsAt != null && !(stamp(limit.resetsAt) > now)) continue;
      const observed = stamp(limit.observedAt ?? snapshot.at);
      if (!Number.isFinite(observed)) continue;
      const previous = latest.get(limit.kind);
      if (!previous || observed > previous.observed) latest.set(limit.kind, { limit, observed });
    }
  }
  return [...latest.values()].map(({ limit }) => limit);
}

async function heartbeatClaudeLimits(run, now) {
  const dir = path.join(run, 'sessions');
  let names;
  try { names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    names = [];
  }
  const beats = await Promise.all(names.map((name) => optionalJson(path.join(dir, name))));
  const windows = new Map();
  for (const beat of beats) {
    if (!object(beat) || !Number.isFinite(stamp(beat.updatedAt)) || now - stamp(beat.updatedAt) > 900_000 ||
        !Array.isArray(beat.limits)) continue;
    for (const limit of beat.limits) {
      if (!object(limit) || typeof limit.kind !== 'string' || !Number.isFinite(limit.percentUsed)) continue;
      if (limit.resetsAt != null && !(stamp(limit.resetsAt) > now)) continue;
      if (!windows.has(limit.kind) || windows.get(limit.kind).percentUsed < limit.percentUsed) {
        windows.set(limit.kind, { ...limit, sessionId: beat.sessionId, updatedAt: beat.updatedAt });
      }
    }
  }
  return [...windows.values()];
}

async function claudeUsage(now) {
  const run = paths().run;
  const collected = await collectorClaudeLimits(run, now);
  const reported = new Set(collected.map(({ kind }) => kind));
  const heartbeat = await heartbeatClaudeLimits(run, now).catch((error) => {
    if (!collected.length) throw error;
    return [];
  });
  const windows = [...collected, ...heartbeat.filter(({ kind }) => !reported.has(kind))];
  return { known: windows.length > 0, nearLimit: windows.some((limit) => limit.percentUsed >= 95), windows };
}

export async function providerState(config, { now = Date.now(), persist = true, excludeCodexAccounts, codexDirectories } = {}) {
  config ??= await loadConfig();
  const accounts = codexAccounts(config);
  const [readings, claude] = await Promise.all([
    Promise.all(accounts.map(async ({ id }) => [id, { ...await codexUsage(id, now, codexDirectories), loggedIn: loggedIn(id) }])),
    claudeUsage(now).catch(() => ({ known: false, nearLimit: false, windows: [] }))
  ]);
  const usage = Object.fromEntries(readings);
  const resolve = async () => {
    const marks = await readProviders();
    const previous = marks.codex;
    const codex = codexMarks(previous);
    const input = { accounts, usage, marks: codex.accounts, previousActive: codex.active, threshold: config.thresholds.codex, now };
    const selected = selectAccount(input);
    codex.active = selected.active;
    for (const { id, switched } of selected.accounts) {
      codex.accounts[id] = { ...(own(codex.accounts, id) ? codex.accounts[id] : {}), switched };
    }
    marks.codex = codex;
    if (persist && !isDeepStrictEqual(previous, codex)) await writeJsonAtomic(paths().providers, marks);
    const eligible = excludeCodexAccounts?.size ? accounts.filter(({ id }) => !excludeCodexAccounts.has(id)) : accounts;
    const { active, allExhausted, reason, accounts: statuses } = eligible.length === accounts.length
      ? selected : selectAccount({ ...input, previousActive: codex.active, accounts: eligible });
    const threshold = { switched: allExhausted, skip: allExhausted, reason, active, accounts: statuses };
    return { providers: marks, threshold };
  };
  const state = await (persist ? withLock(paths().providers, resolve) : resolve());
  const wrappers = Object.create(null);
  for (const provider of ['codex', 'gemini']) {
    try {
      const file = wrapperPath(provider);
      await fs.access(file, constants.R_OK);
      if (!(await fs.stat(file)).isFile()) throw new Error('not a regular file');
      wrappers[provider] = null;
    } catch (error) { wrappers[provider] = `${provider} wrapper unavailable: ${error.code || error.message}`; }
  }
  const codex = { ...usage.main };
  delete codex.loggedIn;
  return { ...state, usage: { codex, codexAccounts: usage, claude }, wrappers, now };
}

function resolveEntries(entries, state, now) {
  return entries.map((entry) => {
    const mark = state.providers[entry.provider];
    let reason = 'available';
    let available = true;
    if (mark && now < stamp(mark.until)) {
      available = false;
      reason = `${entry.provider} unavailable until ${new Date(stamp(mark.until)).toISOString()}: ${mark.reason}`;
    } else if (entry.provider === 'codex' && state.threshold.skip) {
      available = false;
      reason = state.threshold.reason;
    } else if (state.wrappers[entry.provider]) {
      available = false;
      reason = state.wrappers[entry.provider];
    } else if (entry.provider === 'codex') reason = state.threshold.reason;
    return { ...entry, available, reason, ...(entry.provider === 'codex' ? { active: state.threshold.active } : {}) };
  });
}

export async function resolveChain(tier, { config, state, now = Date.now() } = {}) {
  config ??= await loadConfig();
  if (!own(config.tiers, tier)) throw new Error(`unknown tier: ${tier}`);
  state ??= await providerState(config, { now });
  const chain = resolveEntries(config.tiers[tier], state, now);
  return { tier, chain, selected: chain.find((entry) => entry.available) ?? null };
}

export async function resolvePanel(panel, { config, state, now = Date.now(), firstAvailable = false } = {}) {
  config ??= await loadConfig();
  if (!own(config.panels, panel)) throw new Error(`unknown panel: ${panel}`);
  state ??= await providerState(config, { now });
  const seats = resolveEntries(config.panels[panel], state, now).map((entry, seat) => ({ seat, ...entry }));
  return { panel, seats, selected: firstAvailable ? seats.find((entry) => entry.available) ?? null : null };
}

export async function renderRoles(out) {
  const config = await loadConfig();
  const home = process.env.CLAUDE_HOME_DIR || path.join(homedir(), '.claude');
  out = path.resolve(out || path.join(home, 'rules', 'pstack-models.md'));
  const lines = [
    '# Generated from orchestration.json.', '# Edit through the Luna panel.', '# defaults: 2', '# budget: large'
  ];
  for (const [role, target] of Object.entries(config.roles)) {
    const separator = target.indexOf(':'), kind = target.slice(0, separator), name = target.slice(separator + 1);
    const seats = kind === 'panel' ? ' = ' + config.panels[name]
      .map((entry) => `${entry.provider}/${entry.model}/${entry.effort}`).join(', ') : '';
    lines.push(`${role}: ${kind} ${name}${seats}`);
  }
  await writeTextAtomic(out, `${lines.join('\n')}\n`);
  return out;
}

export async function recordSwitch(event) {
  return withLock(paths().switches, () => fs.appendFile(paths().switches,
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 }));
}
