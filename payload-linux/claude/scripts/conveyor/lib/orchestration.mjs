import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readProcess } from '../../lib/luna-runtime.mjs';

const providers = ['codex', 'gemini', 'claude'];
const reasons = ['quota', 'region', 'auth', 'start'];
const defaultFile = new URL('../../../conveyor/orchestration.default.json', import.meta.url);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const stamp = (value) => typeof value === 'number' ? value : Date.parse(value);
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

function keys(value, required, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) throw new Error(`unknown ${label === 'config' ? 'top-level' : label} key: ${key}`);
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
  keys(config, required, 'config');
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
  const config = await readJson(paths().config, undefined);
  return validateConfig(config === undefined ? JSON.parse(await fs.readFile(defaultFile, 'utf8')) : config);
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
  const process = readProcess(owner?.pid);
  if (process && process.state !== 'Z' && process.started === String(owner?.pid_start)) return;
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

async function withLock(file, work) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  const owner = { pid: process.pid, pid_start: readProcess(process.pid)?.started, token: randomUUID() };
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
  return config;
}

export async function saveConfig(config, options = {}) {
  const copy = structuredClone(validateConfig(config));
  return withLock(paths().config, () => saveUnlocked(copy, options));
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

export async function markUnavailable(provider, reason, note, { config, now = Date.now() } = {}) {
  if (!providers.includes(provider)) throw new Error(`unknown provider: ${provider}`);
  if (!reasons.includes(reason)) throw new Error(`unknown unavailable reason: ${reason}`);
  config ??= await loadConfig();
  return withLock(paths().providers, async () => {
    const marks = await readProviders();
    marks[provider] = {
      ...marks[provider], until: new Date(now + config.unavailable_ttl_s[reason] * 1000).toISOString(),
      reason, note, at: new Date(now).toISOString()
    };
    await writeJsonAtomic(paths().providers, marks);
    return marks[provider];
  });
}

async function codexUsage(now) {
  const run = paths().run;
  const candidates = await Promise.all([
    optionalJson(path.join(run, 'codex-limits.json')),
    optionalJson(path.join(run, 'daemon-net', 'codex-limits.json'))
  ]);
  const limits = candidates.filter(object).sort((a, b) => (stamp(b.at) || 0) - (stamp(a.at) || 0))[0];
  if (!limits) return { known: false, ageS: null, stale: false, primary: null, secondary: null };
  const ageS = Number.isFinite(stamp(limits.at)) ? Math.max(0, (now - stamp(limits.at)) / 1000) : null;
  return { ...limits, ageS, stale: ageS !== null && ageS > 1800, known: ageS !== null && ageS <= 1800 };
}

async function claudeUsage(now) {
  const dir = path.join(paths().run, 'sessions');
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
      if (!windows.has(limit.kind) || windows.get(limit.kind).percentUsed < limit.percentUsed) {
        windows.set(limit.kind, { ...limit, sessionId: beat.sessionId, updatedAt: beat.updatedAt });
      }
    }
  }
  return { known: windows.size > 0, nearLimit: [...windows.values()].some((limit) => limit.percentUsed >= 95),
    windows: [...windows.values()] };
}

const used = (window) => Number.isFinite(window?.usedPercent) && window.usedPercent >= 0 ? window.usedPercent : null;

function thresholdState(config, usage, previous) {
  const { switch_percent: threshold, hysteresis_percent: hysteresis, windows } = config.thresholds.codex;
  const switched = previous === true;
  const readings = windows.map((name) => ({ name, window: usage[name], percent: used(usage[name]) }));
  if (!usage.known || readings.every((reading) => reading.percent === null)) {
    return { switched, skip: false, reason: `codex limits unknown${usage.stale ? ' (stale)' : ''}` };
  }
  const high = readings.find((reading) => reading.percent !== null && reading.percent >= threshold);
  const recovered = readings.every((reading) => reading.percent !== null && reading.percent < threshold - hysteresis);
  const skip = Boolean(high) || (switched && !recovered);
  if (!skip) return { switched: false, skip: false, reason: 'available' };
  const limiting = high || readings.find((reading) =>
    reading.percent !== null && reading.percent >= threshold - hysteresis);
  const mins = limiting?.window?.windowMins;
  const label = mins ? `${mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`} window`
    : `${limiting?.name || 'unknown'} window`;
  const reason = limiting
    ? `codex ${limiting.percent}% ≥ ${high ? threshold : threshold - hysteresis}% ` +
      `(${label}${high ? '' : '; hysteresis'})`
    : `codex hysteresis: waiting for every configured window below ${threshold - hysteresis}%`;
  return { switched: true, skip: true, reason };
}

export async function providerState(config, { now = Date.now(), persist = true } = {}) {
  config ??= await loadConfig();
  const [codex, claude] = await Promise.all([codexUsage(now), claudeUsage(now)]);
  const resolve = async () => {
    const marks = await readProviders();
    const threshold = thresholdState(config, codex, marks.codex?.switched);
    if (threshold.switched !== (marks.codex?.switched === true)) {
      marks.codex = { ...marks.codex, switched: threshold.switched };
      if (persist) await writeJsonAtomic(paths().providers, marks);
    }
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
  return { ...state, usage: { codex, claude }, wrappers, now };
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
    return { ...entry, available, reason };
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
