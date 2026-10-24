/** Real Chromium ServiceWorker installation, offline navigation and explicit upgrade.
 * Uses a temporary copy of the built shell and an actual loopback file server.
 * The second shell changes only its build identity; no user save or live host is used.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aethelgard-update-'));
const reportPath = path.join(root, 'test-results/browser-update.json');
const report = { timestamp: new Date().toISOString(), checks: [], pageErrors: [], externalRequests: [] };
let browser, server;
const check = (name, detail) => { report.checks.push({ name, passed: true, detail }); console.log('PASS', name); };
const ready = page => page.waitForFunction(() => typeof AethelgardApp !== 'undefined' && AethelgardApp.canWrite());
try {
  for (const file of ['index.html', 'open_world_mud.html', 'sw.js', 'build-info.json', 'assets/game.css', 'assets/ai-worker.js', 'models/registry.json']) {
    const destination = path.join(directory, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
  const python = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('aethelgard_serve', sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
server=module.make_server(0, directory=sys.argv[2])
print('http://127.0.0.1:%d/' % server.server_port, flush=True)
server.serve_forever()`;
  server = spawn(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-u', '-c', python, path.join(root, 'tools/serve.py'), directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Loopback server did not start: ' + serverLog)), 15000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverLog}`)); });
    server.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'], ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ serviceWorkers: 'allow', locale: 'zh-CN' });
  const origin = new URL(base).origin;
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) { report.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'load' }); await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const first = await page.evaluate(() => AethelgardApp.getBuild());
  const progress = await page.evaluate(() => {
    for (const direction of findShortestPath(state.world.currentRoom, 'r_wilds_trail')) moveDirection(direction);
    harvestRoomNodes(); GameDirector.close(); saveGameState(false);
    return { room: state.world.currentRoom, herbs: state.player.inventory['Moonpetal Herb'] };
  });
  check('real offline shell installs and controls the current page', first);
  await context.setOffline(true);
  await page.goto(base + 'index.html?offline=1', { waitUntil: 'load' }); await ready(page);
  assert.equal(await page.evaluate(() => AethelgardApp.getBuild().id), first.id);
  assert.deepEqual(await page.evaluate(() => ({ room: state.world.currentRoom, herbs: state.player.inventory['Moonpetal Herb'] })), progress);
  check('cached query-string navigation works offline and keeps the hero');
  await context.setOffline(false);

  const second = { ...first, id: first.id === '0000000000000011' ? '0000000000000012' : '0000000000000011' };
  for (const file of ['index.html', 'open_world_mud.html']) {
    const filename = path.join(directory, file);
    const original = fs.readFileSync(filename, 'utf8');
    const updated = original.replace(/window\.AETHELGARD_BUILD = Object\.freeze\(\{[^\n]+?\}\);/, 'window.AETHELGARD_BUILD = Object.freeze(' + JSON.stringify(second) + ');');
    assert.notEqual(updated, original); fs.writeFileSync(filename, updated);
  }
  fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify(second));
  const workerFile = path.join(directory, 'sw.js');
  fs.writeFileSync(workerFile, fs.readFileSync(workerFile, 'utf8').replace(first.id, second.id));
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); await AethelgardApp.checkForUpdate(); });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
  await page.locator('#app-update-banner').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => AethelgardApp.getBuild().id), first.id);
  await page.reload({ waitUntil: 'load' }); await ready(page);
  assert.equal(await page.evaluate(() => AethelgardApp.getBuild().id), first.id);
  check('a downloaded replacement waits; ordinary reload retains a coherent current shell');

  await context.setOffline(true);
  await Promise.all([
    page.waitForEvent('load', { timeout: 30000 }),
    page.locator('#app-update-now').click()
  ]);
  await ready(page);
  assert.equal(await page.evaluate(() => AethelgardApp.getBuild().id), second.id);
  assert.deepEqual(await page.evaluate(() => ({ room: state.world.currentRoom, herbs: state.player.inventory['Moonpetal Herb'] })), progress);
  const shellCaches = await page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('aethelgard-shell-')));
  assert.deepEqual(shellCaches, ['aethelgard-shell-' + second.id]);
  check('Save and update activates a waiting build offline, reloads once and preserves progress');
  await page.goto(base + '?after-update=1', { waitUntil: 'load' }); await ready(page);
  assert.equal(await page.evaluate(() => AethelgardApp.getBuild().id), second.id);
  check('updated root navigation with a query remains available offline');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []);
  check('no page errors or external requests'); report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack || String(error); process.exitCode = 1; console.error(report.error);
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(directory, { recursive: true, force: true }); console.log('Report:', reportPath);
}
