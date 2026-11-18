import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

let invocation = 0;

// Tests in each file run sequentially. Restore all process state before the next fixture invocation.
export async function invoke(main, args, {
  env, cwd, input, prefix = 'ledger', errorCode = 1, captureChildren = false
} = {}) {
  const saved = {
    env: process.env, cwd: process.cwd(), stdout: process.stdout.write, stderr: process.stderr.write,
    stdin: Object.getOwnPropertyDescriptor(process, 'stdin'), exitCode: process.exitCode, spawn: childProcess.spawn
  };
  const result = { status: 0, signal: null, stdout: '', stderr: '' };
  const capture = (key) => (chunk, encoding, callback) => {
    // node:test sends binary protocol frames through stdout while an async invocation is running.
    if (Buffer.isBuffer(chunk)) return saved[key].call(process[key], chunk, encoding, callback);
    result[key] += chunk;
    if (typeof encoding === 'function') encoding();
    else callback?.();
    return true;
  };
  try {
    process.env = { ...(env || process.env) };
    if (cwd) process.chdir(cwd);
    process.stdout.write = capture('stdout');
    process.stderr.write = capture('stderr');
    if (captureChildren) {
      // Keep real wrapper processes and capture their inherited output as the CLI subprocess used to do.
      childProcess.spawn = (command, argv, options) => {
        if (options?.stdio !== 'inherit') return saved.spawn(command, argv, options);
        const child = saved.spawn(command, argv, { ...options, stdio: ['inherit', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk) => process.stdout.write(chunk.toString()));
        child.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));
        return child;
      };
      syncBuiltinESMExports();
    }
    if (input !== undefined) {
      Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([input]) });
    }
    result.status = await main(args) ?? 0;
  } catch (error) {
    result.status = errorCode;
    const message = prefix === 'ledger' ? error.message
      : error.message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    result.stderr += `${prefix}: ${message}\n`;
  } finally {
    process.env = saved.env;
    process.chdir(saved.cwd);
    process.stdout.write = saved.stdout;
    process.stderr.write = saved.stderr;
    Object.defineProperty(process, 'stdin', saved.stdin);
    process.exitCode = saved.exitCode;
    if (captureChildren) {
      childProcess.spawn = saved.spawn;
      syncBuiltinESMExports();
    }
  }
  return result;
}

export function invokeHook(file, options) {
  // These hooks have top-level await but no exported main. Import the real entry point for every event.
  return invoke(() => import(`${pathToFileURL(file).href}?fixture=${++invocation}`).then(() => 0), [], options);
}

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const shellList = (values) => values.map(shellQuote).join(' ');

// The fake git scripts use only shell builtins, including their JSON call log.
export const shellLog = String.raw`
json_string() {
  local argument=$1
  argument=${'${'}argument//\\/\\\\}
  argument=${'${'}argument//\"/\\\"}
  printf '"%s"' "$argument"
}
json_args() {
  local separator= argument
  printf '['
  for argument do
    printf '%s' "$separator"
    json_string "$argument"
    separator=,
  done
  printf ']'
}
log_call() {
  local kind=$1
  shift
  { printf '{"kind":"%s","args":' "$kind"; json_args "$@"; printf '}\n'; } >> "$FAKE_CALLS"
}
`;

export function gitState(state) {
  return Object.entries({
    head: state.head, working: state.working || [], committed: state.committed || [],
    files: state.files || [], untracked: state.untracked || []
  }).map(([key, value]) => `${key}=${shellQuote(Array.isArray(value) ? shellList(value) : value)}`).join('\n') + '\n';
}
