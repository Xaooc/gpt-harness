import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { writeJsonAtomic } from '../conveyor/lib/orchestration.mjs';
import { home, killTree } from '../conveyor/lib/platform.mjs';
import { codexEnvironment, loadProxyEnv, resolveCodex } from './luna-runtime.mjs';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value : null;

function limitWindow(window) {
  if (!window || !Number.isInteger(window.usedPercent)) return null;
  const reset = Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000) : null;
  return {
    usedPercent: window.usedPercent,
    windowMins: Number.isInteger(window.windowDurationMins) ? window.windowDurationMins : null,
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null
  };
}

function limitsSnapshot(data, at) {
  const limits = data?.rateLimits;
  if (!object(limits)) return null;
  const byLimitId = Object.fromEntries(Object.entries(data.rateLimitsByLimitId || {})
    .filter(([, value]) => object(value)).map(([id, value]) => [id, {
      name: text(value.limitName), primary: limitWindow(value.primary), secondary: limitWindow(value.secondary),
      reached: text(value.rateLimitReachedType)
    }]));
  return {
    v: 1, at, source: 'probe', planType: text(limits.planType),
    ordinaryUsageAllowed: typeof data.ordinaryUsageAllowed === 'boolean' ? data.ordinaryUsageAllowed : null,
    reached: text(limits.rateLimitReachedType), primary: limitWindow(limits.primary), secondary: limitWindow(limits.secondary),
    byLimitId
  };
}

function startServer(codexHome, env) {
  const cwd = home(env);
  const options = { cwd, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] };
  if (env.LUNA_DAEMON_APP_SERVER_CMD) {
    const command = JSON.parse(env.LUNA_DAEMON_APP_SERVER_CMD);
    if (!Array.isArray(command) || !command[0] || command.some((part) => typeof part !== 'string')) {
      throw new Error('invalid app-server command');
    }
    return spawn(command[0], command.slice(1), { ...options, env });
  }
  loadProxyEnv(env, cwd);
  const binary = resolveCodex(env, cwd);
  const args = ['app-server', '--disable', 'plugins', '--disable', 'apps'];
  if (env.LUNA_POOL_ALLOW_MCP !== '1') {
    let config = '';
    try { config = readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [, name] of config.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)) {
      args.push('-c', `mcp_servers.${name}.enabled=false`);
    }
  }
  return spawn(binary, args, { ...options, env: codexEnvironment(binary, env) });
}

function readLimits(child, signal) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  return new Promise((resolve) => {
    const finish = (reason, limits = null) => {
      signal.removeEventListener('abort', abort);
      lines.removeListener('close', exited);
      lines.close();
      resolve({ reason, limits });
    };
    const abort = () => finish('probe cancelled or timed out');
    const exited = () => finish('app-server exited before replying');
    child.once('error', () => finish('could not start app-server'));
    lines.once('close', exited);
    lines.once('error', exited);
    child.stdin.once('error', exited);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    let awaiting = 1, requestedAt;
    lines.on('line', (line) => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (reply?.id !== awaiting || reply.method !== undefined) return;
      if (reply.error || !object(reply.result)) return finish(awaiting === 1 ? 'initialize failed' : 'rate limits read failed');
      if (awaiting === 1) {
        awaiting = 2;
        send({ method: 'initialized', params: {} });
        // A daemon update received while this request is in flight should take precedence.
        requestedAt = new Date().toISOString();
        send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
      } else {
        const limits = limitsSnapshot(reply.result, requestedAt);
        finish(limits ? null : 'missing rate limits', limits);
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'luna-collector', title: null, version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    } });
  });
}

export async function probeLimits({ codexHome, out, env = process.env, timeoutMs = 30_000, signal }) {
  const failed = (reason, skipped = false) => ({ ok: false, skipped, reason });
  let lease, releaseLease, child, closed;
  let reason = 'could not acquire account lease';
  let result;
  try {
    if (signal?.aborted) return failed('probe cancelled');
    if (process.platform === 'linux') {
      const leases = await import('../account-lease.mjs');
      ({ lease } = leases.tryShared({ purpose: 'collector limits probe' }));
      if (!lease) return failed('account lease unavailable', true);
      releaseLease = leases.releaseLease;
    }
    reason = 'could not start app-server';
    const timeout = AbortSignal.timeout(timeoutMs);
    const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (probeSignal.aborted) return failed('probe cancelled');
    child = startServer(codexHome, { ...env, CODEX_HOME: codexHome });
    closed = new Promise((resolve) => child.once('close', resolve));
    reason = 'rate limits read failed';
    const reply = await readLimits(child, probeSignal);
    if (!reply.limits) result = failed(reply.reason);
    else {
      reason = 'could not write rate limits';
      await writeJsonAtomic(out, reply.limits);
      result = { ok: true, skipped: false, reason: null };
    }
  } catch {
    result = failed(reason);
  } finally {
    try {
      if (child?.pid) killTree(child, 'SIGKILL', { groupOnly: true });
      if (process.platform === 'win32' && child?.exitCode === null && child.signalCode === null) child.kill();
      child?.stdin.destroy();
      child?.stdout.destroy();
      await closed;
    } catch { result = failed('could not stop app-server'); }
    try { if (lease) await releaseLease(lease.id); }
    catch { result = failed('could not release account lease'); }
  }
  return result;
}
