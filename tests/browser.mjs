/** Browser integration, optionally including an actual local WASM generation.
 * The model case blocks external requests while allowing the loopback file server.
 * Run after prepare_offline.py; no mocked model/tokenizer/inference is used.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), useModel = args.includes('--model');
const reportFlag = args.indexOf('--report');
const reportPath = path.resolve(root, reportFlag >= 0 ? args[reportFlag + 1] : 'test-results/browser.json');
const report = { timestamp: new Date().toISOString(), modelRequested: useModel, checks: [], pageErrors: [], externalRequests: [], failedAssets: [] };
let browser, server;
function check(name, detail) { report.checks.push({ name, passed: true, detail }); console.log('PASS', name); }
try {
  server = spawn(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['tools/serve.py', '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local server did not start: ' + serverLog)), 15000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Local server exited ${code}: ${serverLog}`)); });
    server.stdout.on('data', data => {
      const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'], ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' });
  const origin = new URL(base).origin;
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) { report.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) report.failedAssets.push({ url: response.url(), status: response.status() }); });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof AethelgardApp !== 'undefined' && typeof GameDirector !== 'undefined');
  assert.equal(await page.evaluate(() => AethelgardAI.getStatus().model), 'onnx-community/Qwen3-0.6B-ONNX');
  check('six modules boot and default model is Qwen3');
  for (const width of [1440, 980, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(metrics.document <= metrics.viewport + 1, JSON.stringify(metrics));
    check('responsive width ' + width, metrics);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { setLanguage('zh'); GameDirector.startEncounter('first_oath'); });
  await page.locator('.gd-choice').first().click();
  await page.locator('.gd-outcome').waitFor({ state: 'visible' });
  const choice = await page.evaluate(() => { GameDirector.close(); saveGameState(false); return JSON.stringify(GameDirector.ensureState().completed); });
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.evaluate(() => JSON.stringify(GameDirector.ensureState().completed)), choice);
  check('real first story choice survives save and reload');
  await page.locator('#tab-btn-ai').click();
  await page.locator('#ai-local-files').check();
  assert.match(await page.locator('#ai-load-model').innerText(), /离线|offline/i);
  check('offline model control reflects local package mode');
  if (useModel) {
    await page.locator('#ai-load-model').click();
    await page.waitForFunction(() => ['ready', 'error'].includes(AethelgardAI.getStatus().status), null, { timeout: 240000 });
    const status = await page.evaluate(() => AethelgardAI.getStatus());
    assert.equal(status.status, 'ready', JSON.stringify(status));
    const prompt = '从复苏之井去酒馆，第一步往哪个方向走？只回答方向。';
    await page.locator('#ai-prompt-input').fill(prompt);
    await page.locator('#btn-ai-prompt-send').click();
    await page.waitForFunction(() => !AethelgardAI.getStatus().busy && state.aiLogs.some(x => x.source === 'wasm' || x.status === 'error'), null, { timeout: 240000 });
    const answer = await page.evaluate(() => state.aiLogs.at(-1));
    report.model = { loaded: status.actualLoadedModel, prompt, answer, status: await page.evaluate(() => AethelgardAI.getStatus()) };
    assert.equal(answer.source, 'wasm', JSON.stringify(answer));
    assert.ok(answer.outputTokens > 0 && answer.latencyMs > 0, JSON.stringify(answer));
    assert.match(answer.text, /南|south/i);
    assert.equal(await page.locator('.ai-message').last().locator('details').getAttribute('open'), '');
    check('real browser CPU WASM generation with external network blocked', { tokens: answer.outputTokens, latencyMs: answer.latencyMs, text: answer.text });
  }
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.failedAssets, []);
  check('no page errors or external network requests');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('Report:', reportPath);
}
