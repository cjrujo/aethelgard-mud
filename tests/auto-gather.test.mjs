import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { walk } from './harness-campaign.mjs';

const create = options => createHarness({ ...options, modules: ['core', 'gameplay', 'combat', 'auto-gather', 'bootstrap'] });
const status = h => h.json('AutoGather.getStatus()');
const inventory = (h, id) => h.state.player.inventory[id] || 0;
function twoNodes(h) {
  walk(h, 'r_wilds_trail');
  // A multi-node room fixture exercises a valid combination not present in the
  // single-node starter rooms. Actual inventory, permission and reward code run.
  h.run(`WORLD_ROOMS.r_wilds_trail.nodes.push({id:'test_copper',name:'Copper',nameZh:'铜矿',item:'Copper Ore',qty:1})`);
}

test('Auto-gather defaults off, including old saves and non-boolean imported values', () => {
  const h = create();
  try {
    assert.equal(h.state.autoGather, false);
    const herbs = inventory(h, 'Moonpetal Herb');
    walk(h, 'r_wilds_trail');
    assert.equal(inventory(h, 'Moonpetal Herb'), herbs);
    for (const value of [undefined, 'true', 1, {}, null]) {
      h.context.preference = value;
      assert.equal(h.run('AethelgardApp.normalizeSave({...state,autoGather:preference}).autoGather'), false);
    }
    assert.equal(h.run('AethelgardApp.normalizeSave({...state,autoGather:true}).autoGather'), true);
  } finally { h.dispose(); }
});

test('Enabling collects every available node using real talents, companion bonuses and bounty progress', () => {
  const h = create({ lang: 'zh' });
  try {
    twoNodes(h);
    h.run('state.player.talents.pathfinder=2; state.fun.companionIdx=3');
    const herb = inventory(h, 'Moonpetal Herb'), copper = inventory(h, 'Copper Ore'), sta = h.state.player.sta;
    assert.equal(h.run('AutoGather.setEnabled(true)'), true);
    assert.equal(inventory(h, 'Moonpetal Herb'), herb + 2);
    assert.equal(inventory(h, 'Copper Ore'), copper + 3);
    assert.equal(h.state.player.sta, sta - 8);
    assert.equal(h.state.telemetry.harvests, 2);
    assert.equal(h.state.quests.bounties.find(b => b.targetHarvests).progress, 2);
    assert.equal(status(h).gathered, 2);
    assert.equal(status(h).phase, 'complete');
    assert.equal(h.elements.get('btn-auto-gather').getAttribute('aria-pressed'), 'true');
    assert.match(h.elements.get('auto-gather-status').textContent, /已采集 2 处/);
  } finally { h.dispose(); }
});

test('Auto-path travel gathers resources at intermediate rooms as well as its destination', () => {
  const h = create();
  try {
    const before = h.json('state.player.inventory'), sta = h.state.player.sta;
    h.run('AutoGather.setEnabled(true); travelToRoomByClick("r_river_ford")');
    for (let i = 0; i < 6; i++) h.flushTimers({ includeIntervals: true });
    assert.equal(h.state.world.currentRoom, 'r_river_ford');
    assert.equal(inventory(h, 'Moonpetal Herb'), (before['Moonpetal Herb'] || 0) + 1);
    assert.equal(inventory(h, 'Copper Ore'), (before['Copper Ore'] || 0) + 1);
    assert.equal(inventory(h, 'Silver Ore'), (before['Silver Ore'] || 0) + 1);
    assert.equal(h.state.player.sta, sta - 18);
    assert.equal(h.state.telemetry.harvests, 3);
  } finally { h.dispose(); }
});

test('An invalid move and repeated redraws never start another collection pass', () => {
  const h = create();
  try {
    walk(h, 'r_old_mill'); h.run('AutoGather.setEnabled(true)');
    const copper = inventory(h, 'Copper Ore');
    h.run('for(let i=0;i<8;i++)runWorldTick()');
    assert.equal(h.run('moveDirection("n")'), false);
    h.run('for(let i=0;i<8;i++)renderAll()');
    assert.equal(inventory(h, 'Copper Ore'), copper);
    assert.equal(h.state.telemetry.harvests, 1);
    h.run('moveDirection("w");moveDirection("e")');
    assert.equal(inventory(h, 'Copper Ore'), copper + 1, 'a real revisit can collect a regenerated node');
  } finally { h.dispose(); }
});

test('A partially affordable pass gathers now and resumes once stamina recovers, without idle farming or log spam', () => {
  const h = create();
  try {
    twoNodes(h); h.run('state.player.sta=6;AutoGather.setEnabled(true)');
    assert.equal(h.state.telemetry.harvests, 1); assert.equal(h.state.player.sta, 0);
    assert.equal(status(h).pending, 1); assert.equal(status(h).phase, 'stamina');
    const logs = h.state.logs.length;
    h.run('runWorldTick()');
    assert.equal(h.state.telemetry.harvests, 1); assert.equal(h.state.logs.length, logs);
    h.run('runWorldTick()');
    assert.equal(h.state.telemetry.harvests, 2); assert.equal(h.state.player.sta, 2);
    assert.equal(status(h).pending, 0);
    h.run('for(let i=0;i<15;i++)runWorldTick()');
    assert.equal(h.state.telemetry.harvests, 2);
  } finally { h.dispose(); }
});

test('Cooldown and preparation locks are respected without waiting to farm them in place', () => {
  const h = create();
  try {
    walk(h, 'r_celestial_observatory');
    const sta = h.state.player.sta, metal = inventory(h, 'Star-Metal');
    h.run('AutoGather.setEnabled(true)');
    assert.equal(status(h).phase, 'locked');
    assert.equal(h.state.player.sta, sta); assert.equal(inventory(h, 'Star-Metal'), metal);
    h.run('state.quests.completed.push("q4_titan_forge");for(let i=0;i<6;i++)runWorldTick()');
    assert.equal(inventory(h, 'Star-Metal'), metal, 'unlocking preparations in place is not a new arrival');
    h.run('AutoGather.setEnabled(false);AutoGather.setEnabled(true)');
    assert.equal(inventory(h, 'Star-Metal'), metal + 1);
    h.run('AutoGather.setEnabled(false);AutoGather.setEnabled(true)');
    assert.equal(status(h).phase, 'cooldown');
    h.run('for(let i=0;i<10;i++)runWorldTick()');
    assert.equal(inventory(h, 'Star-Metal'), metal + 1);
  } finally { h.dispose(); }
});

test('Manual harvesting settles a pending node before its cooldown can expire', () => {
  const h = create();
  try {
    walk(h, 'r_wilds_trail'); h.run('state.player.sta=0;AutoGather.setEnabled(true)');
    assert.equal(status(h).pending, 1);
    h.run('state.player.sta=6');
    assert.equal(h.run('harvestRoomNodes()'), true);
    assert.equal(status(h).pending, 0);
    h.run('for(let i=0;i<10;i++)runWorldTick()');
    assert.equal(h.state.telemetry.harvests, 1);
  } finally { h.dispose(); }
});

test('Leaving a room replaces its pending pass and turning the switch off cancels the new pass', () => {
  const h = create();
  try {
    walk(h, 'r_wilds_trail'); h.run('state.player.sta=0;AutoGather.setEnabled(true)');
    const herbs = inventory(h, 'Moonpetal Herb');
    h.run('moveDirection("e")');
    assert.equal(status(h).roomId, 'r_old_mill'); assert.equal(status(h).pending, 1);
    h.run('AutoGather.setEnabled(false);for(let i=0;i<10;i++)runWorldTick()');
    assert.equal(h.state.telemetry.harvests, 0); assert.equal(status(h).phase, 'off');
    h.run('AutoGather.setEnabled(true)');
    assert.equal(h.state.telemetry.harvests, 1); assert.equal(inventory(h, 'Moonpetal Herb'), herbs);
  } finally { h.dispose(); }
});

test('Solo and online combat pause pending collection and do not consume gathering stamina', () => {
  for (const kind of ['solo', 'online']) {
    const h = create();
    try {
      walk(h, 'r_wilds_trail'); h.run('state.player.sta=0;AutoGather.setEnabled(true);state.player.sta=20');
      if (kind === 'solo') h.run('engageMob("briar_wolf")');
      else h.run('OnlineRealm.isBusy=()=>true');
      const before = h.json('state.player');
      h.run('for(let i=0;i<6;i++)runWorldTick()');
      assert.equal(status(h).phase, kind === 'solo' ? 'combat' : 'online_battle');
      assert.equal(h.state.telemetry.harvests, 0); assert.deepEqual(h.json('state.player'), before);
      if (kind === 'solo') assert.equal(h.run('CombatDirector.action("flee")'), true);
      else h.run('OnlineRealm.isBusy=()=>false');
      h.run('runWorldTick()'); assert.equal(h.state.telemetry.harvests, 1);
    } finally { h.dispose(); }
  }
});

test('Reload preserves the explicit preference but cancels pending work until the next actual arrival', () => {
  const h = create();
  try {
    walk(h, 'r_wilds_trail'); h.run('state.player.sta=0;AutoGather.setEnabled(true)');
    assert.equal(status(h).pending, 1);
    h.run('saveGameState(false);loadGameState(false)');
    assert.equal(h.state.autoGather, true); assert.equal(status(h).pending, 0); assert.equal(status(h).phase, 'idle');
    h.run('for(let i=0;i<10;i++)runWorldTick()');
    assert.equal(h.state.telemetry.harvests, 0);
    h.run('moveDirection("s");moveDirection("n")');
    assert.equal(h.state.telemetry.harvests, 1);
    h.run('AutoGather.setEnabled(false);saveGameState(false);loadGameState(false)');
    assert.equal(h.state.autoGather, false);
  } finally { h.dispose(); }
});

test('An observer tab cannot enable or execute automatic collection, even after its local heartbeat', () => {
  const storage = new Map(), a = create({ storage, boot: true });
  let b;
  try {
    walk(a, 'r_wilds_trail'); a.run('state.player.sta=0;AutoGather.setEnabled(true);saveGameState(false)');
    b = create({ storage, boot: true });
    const disk = storage.get(a.run('STORAGE_KEY')), before = b.json('state.player');
    assert.equal(b.run('AethelgardApp.canWrite()'), false);
    assert.equal(b.run('AutoGather.setEnabled(false)'), false);
    b.run('runWorldTick();renderAll()');
    assert.equal(status(b).phase, 'read_only'); assert.equal(status(b).pending, 0);
    assert.deepEqual(b.json('state.player'), before); assert.equal(storage.get(a.run('STORAGE_KEY')), disk);
    assert.equal(b.elements.get('btn-auto-gather').disabled, true);
  } finally { a.dispose(); b?.dispose(); }
});

test('English and Chinese commands are idempotent and manual harvesting retains its full-pass stamina check', () => {
  const h = create();
  try {
    twoNodes(h); h.run('state.player.sta=6');
    const before = h.json('({inventory:state.player.inventory,sta:state.player.sta})');
    assert.equal(h.run('harvestRoomNodes()'), false);
    assert.deepEqual(h.json('({inventory:state.player.inventory,sta:state.player.sta})'), before);
    assert.equal(h.run('executeCommand("自动采集 开启")'), true);
    assert.equal(h.state.telemetry.harvests, 1);
    assert.equal(h.run('executeCommand("autogather on")'), true); assert.equal(status(h).pending, 1);
    assert.equal(h.run('executeCommand("auto-gather off")'), true); assert.equal(status(h).pending, 0);
    assert.equal(h.run('executeCommand("自动采集 错误")'), false); assert.equal(h.state.autoGather, false);
  } finally { h.dispose(); }
});
