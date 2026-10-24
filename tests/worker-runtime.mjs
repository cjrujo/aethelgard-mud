/** Start a real, local-only workerd twice to verify durable receipt recovery.
 * Supply an installed, fixed Wrangler CLI via absolute WRANGLER_CLI; this script
 * never downloads tools, authenticates, deploys, or connects to a public realm.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'test-results', 'worker-runtime.json');
const cli = process.env.WRANGLER_CLI;
const expectedVersion = '4.152.0';
const started = Date.now(), processes = new Set();
const report = { test: 'local-workerd-receipt-recovery', passed: false, wrangler: expectedVersion, checks: [], startedAt: new Date(started).toISOString() };
let temporary, runtime, interrupted = false;
function startNode(args) {
  const child = spawn(process.execPath, args, {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(temporary, 'wrangler.log') }
  });
  const proc = { child, logs: '', code: undefined, spawnError: null };
  processes.add(proc);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { proc.logs = (proc.logs + chunk).slice(-12000); });
  proc.closed = new Promise(resolve => {
    child.on('error', error => { proc.spawnError = error; resolve(); });
    child.on('close', code => { proc.code = code; resolve(); });
  });
  return proc;
}
function signalGroup(proc, signal) {
  if (!proc?.child.pid) return;
  try { process.kill(-proc.child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function stopGroup(proc) {
  if (!proc) return;
  signalGroup(proc, 'SIGTERM');
  await Promise.race([proc.closed, delay(2000)]);
  // Killing the whole group also covers Wrangler's workerd/esbuild children.
  signalGroup(proc, 'SIGKILL');
  await Promise.race([proc.closed, delay(2000)]);
  processes.delete(proc);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  interrupted = true;
  for (const proc of processes) signalGroup(proc, 'SIGTERM');
});
async function runNode(args, timeout = 45000) {
  const proc = startNode(args);
  let timer;
  try {
    await Promise.race([proc.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local verification command timed out.')), timeout); })]);
    if (interrupted) throw new Error('Local runtime verification was interrupted.');
    if (proc.spawnError) throw new Error(`Cannot start local verification: ${proc.spawnError.code || proc.spawnError.name}`);
    if (proc.code !== 0) throw new Error(`Local verification command exited with ${proc.code}.`);
    return proc.logs;
  } finally { clearTimeout(timer); await stopGroup(proc); }
}
async function localPort(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(error => error ? reject(error) : resolve(selected));
    });
  });
}
async function launch(port) {
  if (interrupted) throw new Error('Local runtime verification was interrupted.');
  await localPort(port);
  runtime = startNode([cli, 'dev', '--local', '--config', join(root, 'cloudflare-worker', 'wrangler.toml'),
    '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(temporary, 'storage'), '--log-level', 'warn']);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Local runtime verification was interrupted.');
    if (runtime.spawnError || runtime.code !== undefined) throw new Error('Wrangler stopped before the local health endpoint became ready.');
    let health;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health?realm=runtime-readiness`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) health = await response.json();
    } catch {}
    if (health) {
      assert.equal(health.protocol, 11); assert.equal(health.durableReceipts, true); assert(health.build?.id);
      return health;
    }
    await delay(150);
  }
  throw new Error('Local Worker did not become healthy within 45 seconds.');
}
try {
  assert(process.platform !== 'win32', 'Automatic runtime restart requires POSIX process groups; use worker-smoke.mjs manually on Windows.');
  assert(cli && isAbsolute(cli) && (await stat(cli)).isFile(), 'WRANGLER_CLI must be the absolute path of an installed Wrangler CLI file.');
  temporary = await mkdtemp(join(tmpdir(), 'aethelgard-workerd-'));
  const version = await runNode([cli, '--version'], 20000);
  assert(new RegExp(`\\b${expectedVersion.replaceAll('.', '\\.')}\\b`).test(version), `Use pinned Wrangler ${expectedVersion}.`);
  const port = await localPort();
  const health = await launch(port);
  report.build = health.build;
  report.checks.push('real Worker entrypoint, protocol 11, health and build');
  const smokeArgs = [join(root, 'tests', 'worker-smoke.mjs'), '--url', `http://127.0.0.1:${port}`, '--state', join(temporary, 'synthetic-hero.json')];
  console.log(await runNode([...smokeArgs, '--phase', 'seed']));
  report.checks.push('real WebSocket handshake, upgrade notice and complete duel', 'unacknowledged victory committed to SQLite');
  await stopGroup(runtime); runtime = null;
  const restored = await launch(port);
  assert.equal(restored.build.id, health.build.id, 'A restart must use the same Worker build.');
  console.log(await runNode([...smokeArgs, '--phase', 'recover']));
  report.checks.push('entire runtime stopped and restarted with the same SQLite directory',
    'identical receipt restored for a new session', 'duplicate acknowledgement is idempotent', 'acknowledged receipt is absent after reconnect');
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
  console.error(`FAIL local workerd: ${error.message}`);
  if (runtime?.logs) console.error(runtime.logs.replace(/[a-f0-9]{64}/gi, '[redacted digest]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'));
} finally {
  for (const proc of [...processes]) await stopGroup(proc);
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.durationMs = Date.now() - started;
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (report.passed) console.log('PASS local workerd restart: test-results/worker-runtime.json');
