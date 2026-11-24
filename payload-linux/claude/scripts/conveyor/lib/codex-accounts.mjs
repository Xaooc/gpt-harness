import { existsSync } from 'node:fs';
import path from 'node:path';
import { home } from './platform.mjs';

export function codexAccounts(config) {
  return config.codex_accounts ?? [{ id: 'main', label: 'основной' }];
}

export function validAccountId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(id);
}

export function validateAccounts(accounts) {
  if (!Array.isArray(accounts)) throw new Error('codex_accounts must be an array');
  const ids = new Set();
  for (const account of accounts) {
    if (!account || Object.keys(account).length !== 2 || !Object.hasOwn(account, 'id') ||
        !Object.hasOwn(account, 'label') || !validAccountId(account.id)) {
      throw new Error('codex_accounts entries require an id matching ^[a-z][a-z0-9-]{0,23}$ and a label');
    }
    const { id, label } = account;
    if (ids.has(id)) throw new Error(`duplicate Codex account: ${id}`);
    if (typeof label !== 'string' || !label.length || [...label].length > 40 || /\p{Cc}/u.test(label)) {
      throw new Error(`Codex account ${id}: label must be 1–40 characters without control characters`);
    }
    ids.add(id);
  }
  if (!ids.has('main')) throw new Error('codex_accounts must include main');
}

export function accountPaths(id, env = process.env) {
  if (!validAccountId(id)) throw new Error(`invalid Codex account id: ${id}`);
  const userHome = home(env);
  // LUNA_RUN_DIR isolates a whole run root (tests, a second root): an account read there never sees this machine's.
  const base = path.resolve(env.LUNA_DAEMON_HOME || env.LUNA_RUN_DIR || path.join(userHome, '.claude', 'luna-run'));
  const accountsHome = path.join(userHome, '.codex-accounts');
  // main keeps a CODEX_HOME the caller set, as before accounts existed, unless it is another account's home that a
  // pinned wrapper exported to its children.
  const inherited = env.CODEX_HOME && !path.resolve(env.CODEX_HOME).startsWith(accountsHome + path.sep)
    ? env.CODEX_HOME : null;
  return id === 'main'
    ? { codexHome: path.resolve(env.LUNA_CODEX_MAIN_HOME || inherited || path.join(userHome, '.codex')), runRoot: base }
    : { codexHome: path.join(accountsHome, id), runRoot: path.join(base, 'accounts', id) };
}

export function loggedIn(id) {
  return id === 'main' || existsSync(path.join(accountPaths(id).codexHome, 'auth.json'));
}

export const used = (window) => Number.isFinite(window?.usedPercent) && window.usedPercent >= 0 ? window.usedPercent : null;
export const stamp = (value) => typeof value === 'number' ? value : Date.parse(value);

function thresholdState({ switch_percent: threshold, hysteresis_percent: hysteresis, windows }, usage, previous, now) {
  const switched = previous === true;
  const readings = windows.map((name) => ({ name, window: usage[name], percent: used(usage[name]) }));
  const fresh = usage.known === true && !usage.stale;
  // A depleted business seat reports `reached` (workspace_member_credits_depleted) and refuses work whatever the
  // windows say. It stays out until a fresh reading clears the flag; a stale one holds it until a window resets.
  const resetPending = readings.some(({ window }) => stamp(window?.resetsAt) > now);
  if (typeof usage.reached === 'string' && usage.reached && (fresh || resetPending)) {
    return { switched: true, exhausted: true, known: fresh, reason: `codex limit reached (${usage.reached})` };
  }
  const known = fresh && readings.some((reading) => reading.percent !== null);
  if (!known) {
    return { switched, exhausted: false, known, reason: `codex limits unknown${usage.stale ? ' (stale)' : ''}` };
  }
  const high = readings.find((reading) => reading.percent !== null && reading.percent >= threshold);
  // A window the provider does not report cannot hold the switch.
  const limiting = high || (switched && readings.find((reading) =>
    reading.percent !== null && reading.percent >= threshold - hysteresis));
  if (!limiting) return { switched: false, exhausted: false, known, reason: 'available' };
  const mins = limiting.window?.windowMins;
  const label = mins ? `${mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`} window` : `${limiting.name} window`;
  const reason = `codex ${limiting.percent}% ≥ ${high ? threshold : threshold - hysteresis}% ` +
    `(${label}${high ? '' : '; hysteresis'})`;
  return { switched: true, exhausted: true, known, reason };
}

export function selectAccount({ accounts, usage, marks, previousActive, threshold, now }) {
  const statuses = accounts.map(({ id, label }) => {
    const reading = (Object.hasOwn(usage, id) ? usage[id] : null) ?? {};
    const mark = (Object.hasOwn(marks, id) ? marks[id] : null) ?? {};
    const login = reading.loggedIn ?? id === 'main';
    const state = thresholdState(threshold, reading, mark.switched, now);
    const until = stamp(mark.until);
    if (!login) {
      Object.assign(state, { exhausted: true, switched: mark.switched === true, reason: 'not logged in' });
    } else if (until > now) {
      Object.assign(state, {
        exhausted: true, switched: mark.switched === true,
        reason: `codex unavailable until ${new Date(until).toISOString()}: ${mark.reason}`
      });
    }
    return { id, label, loggedIn: login, ...state };
  });
  const usable = statuses.filter((account) => !account.exhausted);
  const known = usable.filter((account) => account.known);
  const ranked = known.length ? known : usable;
  const active = ranked.find(({ id }) => id === previousActive) ?? ranked[0];
  return {
    active: active?.id ?? null, allExhausted: !active, accounts: statuses,
    reason: active?.reason ?? (statuses.length === 1
      ? statuses[0].reason
      : statuses.map(({ id, reason }) => `${id}: ${reason}`).join('; ') || 'no Codex account available')
  };
}
