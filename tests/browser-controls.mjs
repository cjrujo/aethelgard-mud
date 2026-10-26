/** Real Chromium checks for arrival gathering and the draggable atlas.
 * Uses an isolated browser profile and the real game served on loopback.
 * Only scenario state is seeded; no movement, gathering, pointer, or save code is mocked.
 * Model inference is outside this feature regression; external requests are blocked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), reportFlag = args.indexOf('--report');
const reportPath = path.resolve(root, reportFlag < 0 ? 'test-results/browser-controls.json' : args[reportFlag + 1]);
const screenshotDir = path.join(path.dirname(reportPath), 'screenshots');
const report = { timestamp: new Date().toISOString(), modelInferenceIncluded: false, checks: [], pageErrors: [], externalRequests: [], failedAssets: [] };
let browser, server, page;
fs.mkdirSync(screenshotDir, { recursive: true });
const check = (name, detail) => { report.checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) }); console.log('PASS', name); };
const ready = target => target.waitForFunction(() => typeof AutoGather !== 'undefined' && typeof WorldMap !== 'undefined' && typeof AethelgardApp !== 'undefined' && AethelgardApp.canWrite());
function watchPage(target) {
  target.on('pageerror', error => report.pageErrors.push(error.message));
  target.on('response', response => { if (response.status() >= 400) report.failedAssets.push({ url: response.url(), status: response.status() }); });
}
async function blockExternal(context, origin) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) { report.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
}
const snapshot = target => target.evaluate(() => ({
  room: state.world.currentRoom, inventory: { ...state.player.inventory }, stamina: state.player.sta,
  harvests: state.telemetry.harvests, autoGather: state.autoGather, status: AutoGather.getStatus(),
  cooldowns: { ...state.world.harvestedCooldowns }, walking: autoWalkHandle !== null,
}));
const view = target => target.evaluate(() => WorldMap.getView());
const quantity = (state, item) => state.inventory[item] || 0;
function sameView(actual, expected, label) {
  for (const key of ['centerX', 'centerY', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < .15, `${label}: ${key}: ${actual[key]} != ${expected[key]}`);
  assert.equal(actual.mode, expected.mode, label + ': mode');
}
function movedView(actual, expected, label) {
  assert.ok(Math.hypot(actual.centerX - expected.centerX, actual.centerY - expected.centerY) > 1, label);
}
async function roomPoint(target, id) {
  await target.locator('#world-minimap').scrollIntoViewIfNeeded();
  const point = await target.evaluate(roomId => {
    const svg = document.getElementById('world-minimap'), room = WORLD_ROOMS[roomId];
    const value = new DOMPoint(room.x, room.y).matrixTransform(svg.getScreenCTM());
    const hit = document.elementFromPoint(value.x, value.y)?.closest('[data-map-room]');
    return { x: value.x, y: value.y, hit: hit?.getAttribute('data-map-room') };
  }, id);
  assert.equal(point.hit, id, `Room ${id} must be visibly hittable at its rendered center`);
  return point;
}
async function clickRoom(target, id) {
  const point = await roomPoint(target, id);
  await target.mouse.click(point.x, point.y);
  await target.waitForFunction(roomId => state.world.currentRoom === roomId && autoWalkHandle === null, id);
}
async function backgroundPoint(target) {
  await target.locator('#world-minimap').scrollIntoViewIfNeeded();
  const point = await target.evaluate(() => {
    const svg = document.getElementById('world-minimap'), box = svg.getBoundingClientRect();
    for (const yf of [.72, .82, .62, .42]) for (const xf of [.42, .32, .52, .62]) {
      const x = box.left + box.width * xf, y = box.top + box.height * yf;
      const hit = document.elementFromPoint(x, y);
      if ((hit === svg || hit?.ownerSVGElement === svg) && !hit.closest('[data-map-room]')) return { x, y };
    }
    return null;
  });
  assert.ok(point, 'A visible map background point must be available');
  return point;
}
async function mouseDrag(target, start, dx = -65, dy = -28) {
  await target.mouse.move(start.x, start.y);
  await target.mouse.down();
  await target.mouse.move(start.x + dx, start.y + dy, { steps: 10 });
  await target.mouse.up();
}
async function fullMapGeometry(target) {
  const result = await target.evaluate(() => {
    const svg = document.getElementById('world-minimap'), v = svg.viewBox.baseVal;
    const rooms = Object.values(WORLD_ROOMS).filter(room => Number.isFinite(room.x) && Number.isFinite(room.y));
    return { count: rooms.length, view: WorldMap.getView(), clipped: rooms.filter(room =>
      room.x - 14 < v.x || room.x + 14 > v.x + v.width || room.y - 14 < v.y || room.y + 18 > v.y + v.height
    ).map(room => room.id) };
  });
  assert.equal(result.view.mode, 'fit');
  assert.deepEqual(result.clipped, [], 'Fit all must include every current room plus marker padding');
  return result;
}
async function command(target, value) {
  await target.locator('#cmd-input').fill(value);
  await target.locator('#cmd-input').press('Enter');
}

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
  await blockExternal(context, new URL(base).origin);
  page = await context.newPage(); watchPage(page);
  await page.goto(base, { waitUntil: 'load' }); await ready(page);
  report.build = await page.evaluate(() => AethelgardApp.getBuild());
  await page.evaluate(() => {
    setLanguage('zh'); setTickSpeed('paused'); GameDirector.close(); AutoGather.setEnabled(false);
    state.world.currentRoom = 'r_alchemist'; state.world.visitedRooms.push('r_alchemist');
    state.world.harvestedCooldowns = {}; state.player.sta = state.player.maxSta;
    state.player.talents.pathfinder = 0; state.fun.companionIdx = 0;
    renderAll(); WorldMap.centerOnHero();
  });
  assert.equal((await snapshot(page)).autoGather, false);
  const beforeToggle = await snapshot(page);
  await page.locator('#btn-auto-gather').click();
  const enabled = await snapshot(page);
  assert.equal(enabled.autoGather, true);
  assert.equal(quantity(enabled, 'Moonpetal Herb'), quantity(beforeToggle, 'Moonpetal Herb') + 1);
  assert.equal(enabled.stamina, beforeToggle.stamina - 6);
  assert.equal(enabled.harvests, beforeToggle.harvests + 1);
  assert.equal(enabled.cooldowns['r_alchemist:herb_basket'], 5);
  assert.equal(await page.locator('#btn-auto-gather').getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('#auto-gather-status').innerText()).trim());
  await page.screenshot({ path: path.join(screenshotDir, 'controls-auto-gather.png') });
  check('DOM switch gathers the current room with the real stamina cost and cooldown', enabled.status);

  await page.evaluate(() => { for (let i = 0; i < 7; i++) runWorldTick(); });
  const idle = await snapshot(page);
  assert.equal(idle.harvests, enabled.harvests);
  assert.equal(quantity(idle, 'Moonpetal Herb'), quantity(enabled, 'Moonpetal Herb'));
  assert.equal(idle.cooldowns['r_alchemist:herb_basket'], undefined);
  check('expired cooldowns do not restart gathering while standing in the same room');

  await page.locator('#nav-e').click();
  assert.equal((await snapshot(page)).room, 'r_town_square');
  const beforeRoute = await snapshot(page);
  await page.locator('#btn-map-fit-all').click();
  await clickRoom(page, 'r_river_ford');
  const arrived = await snapshot(page);
  for (const item of ['Moonpetal Herb', 'Copper Ore', 'Silver Ore']) assert.equal(quantity(arrived, item), quantity(beforeRoute, item) + 1, `Route should gather ${item}`);
  assert.equal(arrived.harvests, beforeRoute.harvests + 3);
  assert.equal(arrived.stamina, beforeRoute.stamina - 18);
  assert.equal(arrived.walking, false);
  check('real map click route gathers herbs, copper, and silver at each intermediate arrival');

  await page.evaluate(() => { delete state.world.harvestedCooldowns['r_old_mill:node_copper']; });
  await page.locator('#btn-auto-gather').click();
  const beforeOffMove = await snapshot(page);
  await command(page, 'w');
  const offArrival = await snapshot(page);
  assert.equal(offArrival.room, 'r_old_mill');
  assert.equal(offArrival.harvests, beforeOffMove.harvests);
  assert.equal(offArrival.cooldowns['r_old_mill:node_copper'], undefined);
  await page.locator('#btn-auto-gather').click();
  assert.equal((await snapshot(page)).harvests, offArrival.harvests + 1);
  await page.evaluate(() => { state.world.harvestedCooldowns = {}; saveGameState(false); });
  const beforeReload = await snapshot(page);
  await page.reload({ waitUntil: 'load' }); await ready(page);
  const reloaded = await snapshot(page);
  assert.equal(reloaded.autoGather, true);
  assert.equal(reloaded.harvests, beforeReload.harvests);
  assert.deepEqual(reloaded.inventory, beforeReload.inventory);
  assert.equal(reloaded.cooldowns['r_old_mill:node_copper'], undefined);
  assert.equal(await page.locator('#btn-auto-gather').getAttribute('aria-pressed'), 'true');
  check('off disables arrival gathering; reload preserves the switch without starting a new pass');

  await page.evaluate(() => { state.player.sta = 0; });
  const beforeTired = await snapshot(page);
  await command(page, 'w');
  let tired = await snapshot(page);
  assert.equal(tired.room, 'r_wilds_trail');
  assert.equal(tired.status.phase, 'stamina');
  assert.equal(tired.harvests, beforeTired.harvests);
  await page.evaluate(() => runWorldTick());
  assert.equal((await snapshot(page)).harvests, beforeTired.harvests);
  await page.evaluate(() => runWorldTick());
  const recovered = await snapshot(page);
  assert.equal(recovered.harvests, beforeTired.harvests + 1);
  assert.equal(recovered.stamina, 2);
  await page.evaluate(() => { for (let i = 0; i < 7; i++) runWorldTick(); });
  assert.equal((await snapshot(page)).harvests, recovered.harvests);
  check('an arrival waits for natural stamina recovery, completes once, and never farms its cooldown');

  await page.evaluate(() => {
    AutoGather.setEnabled(false); GameDirector.close();
    state.world.currentRoom = 'r_town_square'; renderAll(); WorldMap.centerOnHero();
  });
  const beforePan = await view(page), beforePanHero = await snapshot(page);
  await mouseDrag(page, await backgroundPoint(page));
  const panned = await view(page);
  movedView(panned, beforePan, 'Dragging empty map background must move the camera');
  assert.equal(panned.mode, 'free');
  assert.equal((await snapshot(page)).room, beforePanHero.room);
  assert.equal((await snapshot(page)).walking, false);
  await page.evaluate(() => { runWorldTick(); runWorldTick(); renderAll(); });
  sameView(await view(page), panned, 'Camera must survive heartbeat and full rendering');
  check('background mouse drag moves the camera and survives world heartbeats without moving the hero');

  await page.locator('#btn-map-reset-zoom').click();
  const beforeNodeDrag = await view(page);
  await mouseDrag(page, await roomPoint(page, 'r_blacksmith'), -60, 30);
  movedView(await view(page), beforeNodeDrag, 'Dragging a node must pan the camera');
  assert.equal((await snapshot(page)).room, 'r_town_square');
  assert.equal((await snapshot(page)).walking, false);
  await page.locator('#btn-map-reset-zoom').click();
  await clickRoom(page, 'r_blacksmith');
  assert.equal((await snapshot(page)).room, 'r_blacksmith');
  check('dragging a room marker does not travel; a separate intentional click still travels');

  await page.locator('#btn-map-reset-zoom').click();
  const centered = await view(page);
  assert.equal(centered.mode, 'follow');
  assert.ok(Math.abs(centered.centerX - 165) < .15 && Math.abs(centered.centerY - 260) < .15);
  await page.locator('#world-minimap').focus();
  await page.keyboard.press('ArrowRight');
  const keyed = await view(page);
  assert.ok(keyed.centerX > centered.centerX);
  assert.equal((await snapshot(page)).room, 'r_blacksmith');
  await page.keyboard.press('Home');
  sameView(await view(page), centered, 'Home returns the camera to the hero');
  await page.keyboard.press('f');
  const fit = await fullMapGeometry(page);
  await page.locator('#btn-map-zoom-in').click();
  const zoomed = await view(page);
  assert.ok(zoomed.width < fit.view.width, 'Zoom in should reduce the world visible in the viewport');
  await page.locator('#btn-map-zoom-out').click();
  assert.ok((await view(page)).width > zoomed.width, 'Zoom out should expand the viewport');
  await page.locator('#btn-map-fit-all').click();
  const beforeExpansion = await fullMapGeometry(page);
  await page.locator('#btn-expand-frontier').click();
  const expanded = await fullMapGeometry(page);
  assert.equal(expanded.count, beforeExpansion.count + 3);
  await page.locator('#world-atlas-card').screenshot({ path: path.join(screenshotDir, 'controls-map-desktop.png') });
  check('keyboard, hero centering, zoom, and fit-all include newly generated frontier rooms', { rooms: expanded.count, view: expanded.view });

  await page.setViewportSize({ width: 980, height: 900 });
  await page.locator('#world-minimap').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => Math.abs(WorldMap.getView().width / WorldMap.getView().height - document.getElementById('world-minimap').getBoundingClientRect().width / document.getElementById('world-minimap').getBoundingClientRect().height) < .02);
  await fullMapGeometry(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check('fit-all adapts to the 980px layout without horizontal page overflow');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await blockExternal(mobileContext, new URL(base).origin);
  const mobile = await mobileContext.newPage(); watchPage(mobile);
  await mobile.goto(base, { waitUntil: 'load' }); await ready(mobile);
  await mobile.evaluate(() => { setLanguage('zh'); setTickSpeed('paused'); GameDirector.close(); WorldMap.centerOnHero(); });
  await mobile.locator('#world-minimap').scrollIntoViewIfNeeded();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const beforeTouch = await view(mobile), touchStart = await backgroundPoint(mobile);
  const cdp = await mobileContext.newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchStart.x, y: touchStart.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchStart.x - 60 * i / 8, y: touchStart.y - 28 * i / 8, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const afterTouch = await view(mobile);
  movedView(afterTouch, beforeTouch, 'Native Chromium touch drag must move the map');
  assert.equal(afterTouch.mode, 'free');
  assert.equal((await snapshot(mobile)).room, 'r_town_square');
  assert.equal((await snapshot(mobile)).walking, false);
  await mobile.evaluate(() => runWorldTick());
  sameView(await view(mobile), afterTouch, 'Mobile camera must survive heartbeat');
  await mobile.locator('#btn-map-fit-all').tap();
  const mobileFit = await fullMapGeometry(mobile);
  await mobile.locator('#world-atlas-card').screenshot({ path: path.join(screenshotDir, 'controls-map-mobile.png') });
  check('390px native touch drag pans without travel; full map remains available', { rooms: mobileFit.count, view: mobileFit.view });
  await cdp.detach();
  await mobileContext.close();

  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.failedAssets, []);
  check('no JavaScript errors, failed assets, or external requests');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack || String(error); console.error(report.error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(screenshotDir, 'controls-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('Report:', reportPath);
}
