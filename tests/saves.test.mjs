import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { walk } from './harness-campaign.mjs';

function advance(h) {
  walk(h, 'r_wilds_trail'); h.run('harvestRoomNodes()');
  assert.equal(h.state.player.inventory['Moonpetal Herb'], 2);
}

test('an older tab cannot overwrite newer progress on save, hide or close', () => {
  const storage = new Map(), a = createHarness({ storage, boot: true });
  a.run('saveGameState(false)');
  const b = createHarness({ storage, boot: true }), key = a.run('STORAGE_KEY');
  try {
    assert.equal(a.run('AethelgardApp.canWrite()'), true);
    assert.equal(b.run('AethelgardApp.canWrite()'), false);
    advance(a); assert.equal(a.run('saveGameState(false)'), true);
    const current = storage.get(key);
    assert.equal(b.run('saveGameState(false)'), false);
    b.run('document.hidden=true; document.dispatchEvent({type:"visibilitychange"}); window.dispatchEvent({type:"beforeunload"})');
    assert.equal(storage.get(key), current);
    assert.equal(JSON.parse(current).player.inventory['Moonpetal Herb'], 2);
    assert.equal(b.document.getElementById('main-viewport-grid').inert, true);
    assert.equal(b.run('GameDirector.canMutate()'), false);
  } finally { a.dispose(); b.dispose(); }
});

test('a legacy writer conflict preserves both persisted data and this page recovery snapshot', () => {
  const h = createHarness({ boot: true }), key = h.run('STORAGE_KEY');
  try {
    h.run('saveGameState(false)'); const older = h.storage.getItem(key);
    advance(h);
    // A legacy build ignores the new ownership key and writes externally.
    h.storage.setItem(key, JSON.stringify({ ...JSON.parse(older), savedAt: 'legacy-tab-write' }));
    const external = h.storage.getItem(key);
    assert.equal(h.run('saveGameState(false)'), false);
    assert.equal(h.storage.getItem(key), external);
    const status = h.json('AethelgardApp.getSaveStatus()');
    assert.equal(status.ownership, 'observer'); assert.equal(status.reason, 'conflict');
    assert.equal(JSON.parse(h.storage.getItem(status.conflictKey)).player.inventory['Moonpetal Herb'], 2);
    assert.ok(h.json('AethelgardApp.backups()').some(item => item.key === status.conflictKey));
  } finally { h.dispose(); }
});

test('new chronicle aborts before replacing a hero when the previous backup cannot be stored', () => {
  const h = createHarness({ boot: true }), key = h.run('STORAGE_KEY');
  try {
    advance(h); h.run('saveGameState(false)'); const oldRaw = h.storage.getItem(key), oldPlayer = h.json('state.player');
    h.storage.failWrites = name => name.endsWith('_previous');
    assert.equal(h.run('resetNewGame()'), false);
    assert.equal(h.storage.getItem(key), oldRaw);
    assert.deepEqual(h.json('state.player'), oldPlayer);
    assert.ok(!h.state.logs.some(entry => entry.textZh?.includes('上一位英雄已保留为备份')));
  } finally { h.dispose(); }
});

test('new chronicle and import retain the original hero when main-save persistence fails', () => {
  for (const operation of ['new', 'import']) {
    const h = createHarness({ boot: true }), key = h.run('STORAGE_KEY');
    try {
      advance(h); h.run('saveGameState(false)'); const oldRaw = h.storage.getItem(key), oldPlayer = h.json('state.player');
      h.storage.failWrites = name => name === key;
      if (operation === 'import') {
        const next = h.json('createInitialState()'); next.player.name = 'Imported traveler';
        h.document.getElementById('save-json-textarea').value = JSON.stringify(next);
      }
      assert.equal(h.run(operation === 'new' ? 'resetNewGame()' : 'importSaveJson()'), false);
      assert.equal(h.storage.getItem(key), oldRaw);
      assert.deepEqual(h.json('state.player'), oldPlayer);
      assert.equal(JSON.parse(h.storage.getItem(key + '_previous')).player.inventory['Moonpetal Herb'], 2);
    } finally { h.dispose(); }
  }
});

test('v10 saves migrate, retain independent hero data, and stop an active hunt session on load', () => {
  const h = createHarness();
  try {
    const legacy = h.json('state'); legacy.version = 'v10'; legacy.saveSchema = 10;
    legacy.autoHunt = true; legacy.hunt = { version: 1, mode: 'continuous', session: { status: 'running', roomId: 'r_wilds_trail', targetId: 'briar_wolf', wins: 7, gold: 93 } };
    legacy.ai = { backend: 'rules', knowledge: { version: 1, scopes: { dm: [{ key: 'sister', type: 'person', name: 'Mira', source: 'player' }] } } };
    h.context.legacy = legacy; h.run('AethelgardApp.restore(legacy)');
    assert.equal(h.state.version, 'v11'); assert.equal(h.state.saveSchema, 11);
    assert.equal(h.state.autoHunt, false); assert.equal(h.state.hunt.session.status, 'stopped');
    assert.equal(h.state.hunt.session.stopReason, 'reloaded'); assert.equal(h.state.hunt.session.wins, 7);
    assert.equal(h.state.ai.knowledge.scopes.dm[0].name, 'Mira');
  } finally { h.dispose(); }
});

test('malformed frontier rooms are rejected without replacing the active hero', () => {
  const h = createHarness({ boot: true }), key = h.run('STORAGE_KEY');
  try {
    advance(h); h.run('saveGameState(false)');
    const before = h.json('state.player'), persisted = h.storage.getItem(key);
    const next = h.json('state'); next.player.name = 'Broken import';
    next.world.currentRoom = 'r_frontier_broken';
    next.world.proceduralRooms.push({ id: 'r_frontier_broken', exits: {}, mobs: {} });
    h.document.getElementById('save-json-textarea').value = JSON.stringify(next);
    assert.equal(h.run('importSaveJson()'), false);
    assert.deepEqual(h.json('state.player'), before);
    assert.equal(h.storage.getItem(key), persisted);
    assert.equal(h.run('saveGameState(false)'), true);
    assert.equal(JSON.parse(h.storage.getItem(key)).player.name, before.name);
  } finally { h.dispose(); }
});

test('an exception after an import begins restores the hero and world catalogs before the next save', () => {
  const h = createHarness({ boot: true }), key = h.run('STORAGE_KEY');
  try {
    advance(h); h.run('saveGameState(false)');
    const before = h.json('state.player'), rooms = h.json('WORLD_ROOMS'), titles = h.json('ROOM_TITLE_I18N');
    const next = h.json('state'); next.player.name = 'Broken import';
    next.world.proceduralRooms.push({ id: 'r_frontier_import', title: 'Temporary room', exits: {}, mobs: [], npcs: [], nodes: [], i18nTitle: { zh: '暂存' } });
    h.run(`const savedRenderForTest = renderAll; renderAll = function() {
      if (state.player.name === 'Broken import') throw new Error('Render failed after restoring imported state');
      return savedRenderForTest();
    };`);
    h.document.getElementById('save-json-textarea').value = JSON.stringify(next);
    assert.equal(h.run('importSaveJson()'), false);
    assert.deepEqual(h.json('state.player'), before);
    assert.deepEqual(h.json('WORLD_ROOMS'), rooms);
    assert.deepEqual(h.json('ROOM_TITLE_I18N'), titles);
    assert.equal(h.run('saveGameState(false)'), true);
    assert.equal(JSON.parse(h.storage.getItem(key)).player.name, before.name);
  } finally { h.dispose(); }
});

// Faithful asynchronous exclusive-lock test double: the game still owns all save,
// takeover and recovery behavior. A browser regression also covers real Web Locks.
class LockManager {
  active = null; waiting = [];
  request(name, options, callback) {
    return new Promise((resolve, reject) => {
      const item = { name, options, callback, resolve, reject };
      if (this.active && options.ifAvailable) { queueMicrotask(() => Promise.resolve(callback(null)).then(resolve, reject)); return; }
      options.signal?.addEventListener('abort', () => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) { this.waiting.splice(index, 1); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }
      });
      this.waiting.push(item); this.next();
    });
  }
  next() {
    if (this.active || !this.waiting.length) return;
    const item = this.active = this.waiting.shift();
    queueMicrotask(() => Promise.resolve(item.callback({ name: item.name })).then(item.resolve, item.reject).finally(() => { this.active = null; this.next(); }));
  }
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function linkedTabs(locks) {
  const storage = new Map(), tabs = [];
  const create = () => {
    const h = createHarness({ storage, globals: { navigator: { language: 'en', ...(locks ? { locks } : {}) } } });
    const set = h.storage.setItem.bind(h.storage), remove = h.storage.removeItem.bind(h.storage);
    const notify = (key, newValue) => { for (const other of tabs) if (other !== h) queueMicrotask(() => { other.context.storageEvent = { type: 'storage', key, newValue }; other.run('window.dispatchEvent(storageEvent)'); }); };
    h.storage.setItem = (key, value) => { set(key, value); notify(key, value); };
    h.storage.removeItem = key => { remove(key); notify(key, null); };
    tabs.push(h); h.run('window.onload()'); return h;
  };
  return { storage, tabs, create };
}

for (const mode of ['Web Locks', 'lease fallback']) test(`${mode} refuses takeover when the active hero cannot save, even if all backups also fail`, async () => {
  const { storage, tabs, create } = linkedTabs(mode === 'Web Locks' ? new LockManager() : null);
  const a = create(); await settle(); a.run('saveGameState(false)'); await settle();
  const b = create(); await settle();
  try {
    const key = a.run('STORAGE_KEY'), persisted = storage.get(key);
    a.storage.failWrites = name => name === key || name.includes('_conflict_');
    advance(a);
    const taking = b.run('AethelgardApp.takeOver()'); await settle();
    assert.equal(a.run('AethelgardApp.canWrite()'), true);
    assert.equal(b.run('AethelgardApp.canWrite()'), false);
    assert.equal(storage.get(key), persisted);
    assert.equal(a.state.player.inventory['Moonpetal Herb'], 2);
    for (const [id, timer] of b.timers) if (timer.delay === 3000 && !timer.repeat) { b.timers.delete(id); timer.fn(...timer.args); }
    await settle(); assert.equal(await taking, false);
    a.storage.failWrites = false;
    assert.equal(await b.run('AethelgardApp.takeOver()'), true); await settle();
    assert.equal(b.state.player.inventory['Moonpetal Herb'], 2);
    assert.equal(a.run('AethelgardApp.canWrite()'), false);
  } finally {
    b.run('window.dispatchEvent({type:"beforeunload"})'); await settle(); tabs.length = 0; a.dispose(); b.dispose();
  }
});

test('Web Locks takeover saves the first tab, loads its latest progress, and fences its later unload', async () => {
  const storage = new Map(), locks = new LockManager(), tabs = [];
  const create = () => {
    const h = createHarness({ storage, globals: { navigator: { language: 'en', locks } } });
    const set = h.storage.setItem.bind(h.storage), remove = h.storage.removeItem.bind(h.storage);
    const notify = (key, newValue) => { for (const other of tabs) if (other !== h) queueMicrotask(() => { other.context.storageEvent = { type: 'storage', key, newValue }; other.run('window.dispatchEvent(storageEvent)'); }); };
    h.storage.setItem = (key, value) => { set(key, value); notify(key, value); };
    h.storage.removeItem = key => { remove(key); notify(key, null); };
    tabs.push(h); h.run('window.onload()'); return h;
  };
  const a = create(); await settle(); const b = create(); await settle();
  try {
    assert.equal(a.run('AethelgardApp.canWrite()'), true); assert.equal(b.run('AethelgardApp.canWrite()'), false);
    advance(a); // Includes legitimate game autosaves, never forced state changes.
    const latestHerbs = a.state.player.inventory['Moonpetal Herb'];
    assert.equal(await b.run('AethelgardApp.takeOver()'), true); await settle();
    assert.equal(a.run('AethelgardApp.canWrite()'), false); assert.equal(b.run('AethelgardApp.canWrite()'), true);
    assert.equal(b.state.player.inventory['Moonpetal Herb'], latestHerbs);
    assert.equal(b.state.world.currentRoom, 'r_wilds_trail');
    b.run('saveGameState(false)'); const latest = storage.get(b.run('STORAGE_KEY'));
    a.run('window.dispatchEvent({type:"beforeunload"})'); await settle();
    assert.equal(storage.get(b.run('STORAGE_KEY')), latest);
  } finally { b.run('window.dispatchEvent({type:"beforeunload"})'); await settle(); tabs.length = 0; a.dispose(); b.dispose(); }
});
