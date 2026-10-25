import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, projectRoot } from './harness.mjs';
import { walk, event } from './harness-campaign.mjs';

test('Authored choices grant and persist their exact reward only once', () => {
  const h = createHarness();
  assert.equal(h.run('GameDirector.startEncounter("first_oath").ok'), true);
  const before = h.json('state.player');
  assert.equal(h.run('GameDirector.resolveChoice(0).ok'), true);
  assert.equal(h.state.player.xp, before.xp + 10);
  assert.equal(h.state.player.inventory['Minor Healing Draught'], before.inventory['Minor Healing Draught'] + 1);
  assert.equal(h.state.director.trust.town, 2);
  const rewarded = h.json('state.player');
  assert.equal(h.run('GameDirector.resolveChoice(0).ok'), false);
  h.run('saveGameState(false); loadGameState(false)');
  assert.equal(h.run('GameDirector.startEncounter("first_oath").ok'), false);
  assert.deepEqual(h.json('state.player'), rewarded);
  h.dispose();
});

test('An unaffordable or out-of-location choice has no reward or consumption', () => {
  const h = createHarness();
  h.run('GameDirector.startEncounter("first_oath"); state.player.sta=0');
  const before = h.json('state.player');
  assert.equal(h.run('GameDirector.resolveChoice(1).ok'), false);
  assert.deepEqual(h.json('state.player'), before);
  assert.ok(!h.state.director.completed.first_oath);
  walk(h, 'r_tavern');
  assert.equal(h.run('GameDirector.resolveChoice(0).ok'), false);
  assert.ok(!h.state.director.completed.first_oath);
  h.dispose();
});

test('Saving and reloading an unresolved risk preserves the same roll and consequence', () => {
  const h = createHarness({ seed: 7401 });
  walk(h, 'r_wilds_trail'); h.run('GameDirector.startEncounter("wounded_scout")');
  const checkpoint = h.json('state');
  const first = h.json('GameDirector.resolveChoice(1)');
  h.context.savedRisk = checkpoint; h.run('AethelgardApp.restore(savedRisk)');
  const second = h.json('GameDirector.resolveChoice(1)');
  assert.deepEqual(second, first);
  assert.equal(h.state.player.sta, checkpoint.player.sta - 10);
  h.dispose();
});

test('Trust and boss requirements are enforced by rules, with reachable alternative choices', () => {
  const h = createHarness();
  walk(h, 'r_hunter_camp'); h.run('GameDirector.startEncounter("elara_plan")');
  assert.equal(h.run('GameDirector.resolveChoice(0).ok'), false);
  assert.equal(h.run('GameDirector.resolveChoice(2).ok'), true);
  walk(h, 'r_bandit_stronghold');
  assert.equal(h.run('GameDirector.startEncounter("bandit_ledger").ok'), false);
  walk(h, 'r_astral_core');
  assert.equal(h.run('GameDirector.startEncounter("final_choice").ok'), false);
  h.dispose();
});

test('Landmark rewards cannot be farmed by repeated clicks or loading', () => {
  const h = createHarness();
  const before = h.json('state.player');
  assert.equal(h.run('GameDirector.discover().ok'), true);
  assert.equal(h.state.player.sta, before.sta - 5);
  assert.equal(h.state.player.xp, before.xp + 5);
  const awarded = h.json('state.player');
  assert.equal(h.run('GameDirector.discover().ok'), false);
  h.run('saveGameState(false); loadGameState(false)');
  assert.equal(h.run('GameDirector.discover().ok'), false);
  assert.deepEqual(h.json('state.player'), awarded);
  h.dispose();
});

test('Narration is escaped, separately labeled, token checked and cannot alter authoritative outcomes', () => {
  const h = createHarness({ lang: 'zh' });
  h.run('GameDirector.startEncounter("first_oath")');
  const token = h.state.director.pending.token, before = h.json('state.player');
  assert.equal(h.run(`GameDirector.setNarration('first_oath','wrong','wasm','stale')`), false);
  h.context.narrationToken = token;
  assert.equal(h.run(`GameDirector.setNarration('first_oath','<script>steal()</script> You received 999 gold.','wasm',narrationToken)`), true);
  assert.deepEqual(h.json('state.player'), before);
  h.run('GameDirector.render()');
  const html = h.elements.get('gd-modal-body').innerHTML;
  assert.ok(html.includes('AI补充描写 · 剧情事实以上方原文为准'));
  assert.ok(html.includes('索恩长老托着一枚断裂的铜印'));
  assert.ok(html.includes('&lt;script&gt;steal()&lt;/script&gt;'));
  assert.equal(h.run('GameDirector.resolveChoice(0).ok'), true);
  assert.equal(h.state.player.gold, before.gold);
  assert.equal(h.run(`GameDirector.setNarration('first_oath','late','wasm',narrationToken)`), false);
  h.dispose();
});

test('Guild refresh requires its real location and a fully claimed board', () => {
  const h = createHarness();
  const board = h.json('state.quests.bounties');
  assert.equal(h.run('refreshBounties().reason'), 'guild_location');
  walk(h, 'r_guild_hall');
  assert.equal(h.run('refreshBounties().reason'), 'unfinished_contracts');
  assert.deepEqual(h.json('state.quests.bounties'), board);
  const before = h.state.player.gold;
  h.run('claimBounty("b1")'); assert.equal(h.state.player.gold, before);
  h.run('state.quests.bounties.forEach(b=>b.claimed=true)'); // isolated completed-board fixture
  assert.equal(h.run('refreshBounties().ok'), true);
  assert.ok(h.state.quests.bounties.every(b => !b.claimed && b.progress === 0));
  const fresh = h.json('state.quests.bounties');
  assert.equal(h.run('refreshBounties().ok'), false);
  assert.deepEqual(h.json('state.quests.bounties'), fresh);
  h.dispose();
});

test('An online battle blocks solo story, reward, discovery and travel mutations', () => {
  const h = createHarness();
  h.run('GameDirector.startEncounter("first_oath"); OnlineRealm.isBusy=()=>true');
  const before = h.json('({player:state.player,room:state.world.currentRoom,director:state.director})');
  assert.equal(h.run('GameDirector.resolveChoice(0).ok'), false);
  assert.equal(h.run('GameDirector.startEncounter().ok'), false);
  assert.equal(h.run('GameDirector.discover().ok'), false);
  assert.equal(h.run('GameDirector.followObjective()'), false);
  assert.equal(h.run('moveDirection("n")'), false);
  assert.deepEqual(h.json('({player:state.player,room:state.world.currentRoom,director:state.director})'), before);
  h.dispose();
});

test('Journey guidance and its live button follow the current objective', () => {
  const h = createHarness({ lang: 'zh' });
  h.run('renderAll()');
  assert.ok(h.elements.get('smart-next-step-text').textContent.includes('索恩'));
  h.elements.get('btn-proceed-next-step').click();
  assert.equal(h.state.director.pending.id, 'first_oath');
  h.run('GameDirector.resolveChoice(0); GameDirector.close(); renderAll()');
  h.elements.get('btn-proceed-next-step').click();
  assert.equal(h.state.world.currentRoom, 'r_tavern');
  assert.equal(h.run('GameDirector.objective().event'), 'tavern_courier');
  h.dispose();
});

test('Combat blocks authored choices and landmarks until the encounter finishes', () => {
  const h = createHarness();
  walk(h, 'r_wilds_trail'); h.run('GameDirector.startEncounter("wounded_scout"); engageMob("briar_wolf")');
  const before = h.json('({player:state.player,completed:state.director.completed,discoveries:state.director.discoveries})');
  assert.equal(h.run('GameDirector.resolveChoice(0).ok'), false);
  assert.equal(h.run('GameDirector.discover().ok'), false);
  assert.deepEqual(h.json('({player:state.player,completed:state.director.completed,discoveries:state.director.discoveries})'), before);
  h.dispose();
});

test('Malformed save schemas cannot replace the current hero', () => {
  const h = createHarness(); event(h, 'first_oath', 0);
  const before = h.json('state');
  assert.throws(() => h.run('AethelgardApp.restore({player:{classId:"nonexistent"},world:{}})'), /Unknown hero class/);
  assert.deepEqual(h.json('state'), before);
  assert.throws(() => h.run('AethelgardApp.restore({notASave:true})'), /not an Aethelgard save/);
  assert.deepEqual(h.json('state'), before);
  h.dispose();
});

test('Malformed optional save extensions are normalized before rendering', () => {
  const h = createHarness();
  h.run(`AethelgardApp.restore({...JSON.parse(JSON.stringify(state)),fun:{companionIdx:-1,companionLevel:25,overdrive:900},director:{journal:[null,"bad",{id:'kept',title:'Valid',body:'History'}]},combatLedger:3})`);
  assert.equal(h.state.fun.companionIdx, 0);
  assert.equal(h.state.fun.companionLevel, 25, 'legacy companion progression is retained; damage scaling is bounded by the combat rules');
  assert.equal(h.state.fun.overdrive, 100);
  assert.ok(h.state.director.journal.every(entry => entry && typeof entry === 'object'));
  assert.ok(h.state.director.journal.some(entry => entry.id === 'kept'));
  assert.equal(typeof h.state.combatLedger, 'object');
  assert.doesNotThrow(() => h.run('renderAll(); GameDirector.startEncounter("first_oath"); GameDirector.resolveChoice(0)'));
  h.dispose();
});

test('Unreadable local save is retained when even the backup write fails', () => {
  const h = createHarness();
  const key = h.run('STORAGE_KEY'), unreadable = '{ damaged save';
  h.storage.setItem(key, unreadable); h.storage.failWrites = true;
  assert.equal(h.run('loadGameState(false)'), false);
  h.storage.failWrites = false;
  assert.equal(h.run('saveGameState(false)'), false);
  assert.equal(h.storage.getItem(key), unreadable);
  assert.equal(h.run('AethelgardApp.restore(createInitialState())'), true);
  assert.equal(h.run('saveGameState(false)'), true);
  assert.equal(JSON.parse(h.storage.getItem(key)).saveSchema, 11);
  h.dispose();
});

test('Unreadable local save is backed up before a fresh chronicle can save', () => {
  const h = createHarness(), key = h.run('STORAGE_KEY'), unreadable = '{ damaged save';
  h.storage.setItem(key, unreadable);
  assert.equal(h.run('loadGameState(false)'), false);
  const backups = [...h.storage.data].filter(([name]) => name.startsWith(key + '_unreadable_'));
  assert.equal(backups.length, 1); assert.equal(backups[0][1], unreadable);
  assert.equal(h.run('saveGameState(false)'), true);
  assert.equal(h.storage.getItem(backups[0][0]), unreadable);
  h.dispose();
});

test('New chronicle clears generated catalogs, while previous-hero restore rebuilds owned gear and rooms', () => {
  const h = createHarness();
  const id = h.run('CombatDirector.grantLoot({source:"fixture",level:1,token:"reset-test",slot:"weapon"})');
  h.run(`equipOrUseItem(${JSON.stringify(id)}); expandProceduralFrontier(1,true); saveGameState(false)`);
  const roomIds = h.json('state.world.proceduralRooms.map(room=>room.id)');
  assert.equal(roomIds.length, 1);
  h.run('resetNewGame()');
  assert.equal(h.run(`Boolean(ITEM_CATALOG[${JSON.stringify(id)}])`), false);
  assert.equal(h.run(`Boolean(WORLD_ROOMS[${JSON.stringify(roomIds[0])}])`), false);
  assert.ok(!h.state.player.inventory[id]);
  h.run('AethelgardApp.restorePrevious()');
  assert.equal(h.state.player.equipment.weapon, id);
  assert.equal(h.run(`Boolean(ITEM_CATALOG[${JSON.stringify(id)}])`), true);
  assert.equal(h.run(`Boolean(WORLD_ROOMS[${JSON.stringify(roomIds[0])}])`), true);
  h.dispose();
});

test('Legacy v9 saves migrate with defaults and never resume unattended attacks or stale generation', () => {
  const h = createHarness();
  h.run(`AethelgardApp.restore({version:'v9',player:{name:'Veteran',classId:'vanguard',gold:90},world:{currentRoom:'missing'},autoHunt:true,aiLogs:[{status:'generating',text:''}]})`);
  assert.equal(h.state.version, 'v11'); assert.equal(h.state.saveSchema, 11);
  assert.equal(h.state.player.name, 'Veteran'); assert.equal(h.state.player.gold, 90);
  assert.equal(h.state.world.currentRoom, 'r_town_square');
  assert.equal(h.state.autoHunt, false); assert.equal(h.state.aiLogs[0].status, 'cancelled');
  assert.equal(h.state.player.cooldowns.length, 3);
  h.dispose();
});

test('Every direct static UI handler resolves and all production modules render together', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(projectRoot, 'models/registry.json'), 'utf8'));
  const h = createHarness({ modules: ['core', 'gameplay', 'combat', 'auto-gather', 'map-controls', 'ai-dm', 'online', 'bootstrap'], globals: { AETHELGARD_MODEL_REGISTRY: registry } });
  const html = fs.readFileSync(path.join(projectRoot, 'src/game.html'), 'utf8');
  const handlers = [...new Set([...html.matchAll(/\bon(?:click|submit|change)="([^"]+)"/g)].flatMap(match => [...match[1].matchAll(/(?:^|;)\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(call => call[1])))];
  assert.ok(handlers.length > 0, 'the template must contain discoverable event handlers');
  for (const name of handlers) assert.equal(h.run(`typeof ${name}`), 'function', `Missing handler: ${name}`);
  assert.doesNotThrow(() => h.run('renderAll()'));
  h.dispose();
});

test('Skipping a recommendation preserves its unresolved choice and permits a rewarding revisit exactly once', () => {
  const h=createHarness();
  try {
    const before=h.json('({gold:state.player.gold,xp:state.player.xp,inventory:state.player.inventory})');
    assert.equal(h.run('GameDirector.skipObjective()'),true);assert.equal(h.state.director.skipped.first_oath,true);assert.ok(!h.state.director.completed.first_oath);
    assert.deepEqual(h.json('({gold:state.player.gold,xp:state.player.xp,inventory:state.player.inventory})'),before);
    assert.equal(h.run('GameDirector.objective().event'),'tavern_courier');
    assert.equal(h.run('GameDirector.revisit("first_oath")'),true);assert.equal(h.run('GameDirector.objective().event'),'first_oath');
    h.run('GameDirector.followObjective()');assert.equal(h.run('GameDirector.resolveChoice(0).ok'),true);
    assert.ok(h.state.director.completed.first_oath);assert.ok(!h.state.director.skipped.first_oath);assert.equal(h.state.director.revisit,null);
    const awarded=h.json('state.player');assert.equal(h.run('GameDirector.revisit("first_oath")'),false);assert.deepEqual(h.json('state.player'),awarded);
    h.run('saveGameState(false);loadGameState(false)');assert.equal(h.run('GameDirector.objective().event'),'tavern_courier');
  } finally {h.dispose();}
});

test('Legacy completed chapters continue from their current chapter, and a completed campaign always retains a reachable guardian ending', () => {
  const h=createHarness();
  try {
    // Compatibility fixture: old chronicle has completed chapter IDs but no new
    // director stories, training data, or duplicated defeated-boss ledger.
    h.run('state.quests.completed=["q1_wilds","q2_bandit_king"];GameDirector.ensureState()');
    assert.equal(h.run('GameDirector.objective().event'),'bandit_ledger');
    assert.equal(h.run('GameDirector.revisit("first_oath")'),true);assert.equal(h.run('GameDirector.skipObjective()'),true);
    h.run('state.quests.completed=STORY_QUESTS.map(q=>q.id)');
    assert.equal(h.run('GameDirector.objective().event'),'final_choice');
    walk(h,'r_astral_core');assert.equal(h.run('GameDirector.followObjective().ok'),true);
    assert.equal(h.run('GameDirector.resolveChoice(0).ok'),false,'missing seals must not be silently invented');
    assert.equal(h.run('GameDirector.resolveChoice(1).ok'),true);assert.equal(h.state.director.ending,'guardian');
  } finally {h.dispose();}
});

test('Final-choice readiness links to missing leads without reopening completed decisions', () => {
  const h=createHarness({lang:'zh'});
  try {
    h.run('state.quests.completed=STORY_QUESTS.map(q=>q.id)');walk(h,'r_astral_core');h.run('GameDirector.followObjective();GameDirector.render()');
    const html=h.document.getElementById('gd-modal-body').innerHTML;
    assert.ok(html.includes('守护结局始终可选'));assert.ok(html.includes("GameDirector.revisit('menhir_root')"));assert.ok(html.includes('需要保留三枚封印'));
    assert.equal(h.run('GameDirector.revisit("menhir_root")'),true);assert.equal(h.run('GameDirector.objective().target'),'r_ancient_menhir');
    walk(h,'r_ancient_menhir');h.run('GameDirector.followObjective();GameDirector.resolveChoice(1);GameDirector.close()');
    assert.equal(h.run('GameDirector.revisit("menhir_root")'),false,'a deliberately rejected seal remains a real consequence');
    assert.ok(!h.state.director.flags.sigil_root);
  } finally {h.dispose();}
});

test('Guild and hunting controls are visible, priced and backed by live production APIs', () => {
  const h=createHarness({lang:'zh'});
  try {
    h.run('GameDirector.open("guild")');let html=h.document.getElementById('gd-modal-body').innerHTML;
    assert.ok(html.includes('裂隙碎片'));assert.ok(html.includes('金币'));assert.ok(html.includes('Companion')||html.includes('伙伴培养'));
    assert.ok(html.includes('GameDirector.redeemSelectedSet()'));assert.ok(html.includes('CombatDirector.trainCompanion(1)'));
    h.run('GameDirector.changeTab("hunt")');html=h.document.getElementById('gd-modal-body').innerHTML;
    assert.ok(html.includes('一场即停'));assert.ok(html.includes('当前击杀契约'));assert.ok(html.includes('连续狩猎'));assert.ok(html.includes('22–90%'));
    assert.ok(h.document.getElementById('gd-journey').innerHTML.includes("GameDirector.open('guild')"));
  } finally {h.dispose();}
});

test('Read-only saves cannot change a story recommendation, choice, discovery or route', () => {
  const h=createHarness();
  try {
    h.run('GameDirector.startEncounter("first_oath");window.AethelgardApp={...window.AethelgardApp,canWrite:()=>false}');
    const before=h.json('({player:state.player,director:state.director,room:state.world.currentRoom})');
    assert.equal(h.run('GameDirector.skipObjective()'),false);assert.equal(h.run('GameDirector.resolveChoice(0).ok'),false);
    assert.equal(h.run('GameDirector.revisit("menhir_root")'),false);assert.equal(h.run('GameDirector.discover().ok'),false);assert.equal(h.run('GameDirector.followObjective()'),false);
    assert.deepEqual(h.json('({player:state.player,director:state.director,room:state.world.currentRoom})'),before);
  } finally {h.dispose();}
});

test('World resource recovery does not rebuild service forms or erase a draft hunting configuration', () => {
  const h=createHarness();
  try {
    for(const tab of ['guild','hunt']) {
      h.run(`state.player.mp=0;state.player.sta=0;GameDirector.open(${JSON.stringify(tab)})`);
      const body=h.document.getElementById('gd-modal-body');let html=body.innerHTML,writes=0;
      Object.defineProperty(body,'innerHTML',{configurable:true,get:()=>html,set:value=>{html=value;writes++;}});
      h.run('runWorldTick();runWorldTick()');assert.equal(writes,0,`${tab} form should survive unrelated MP/STA recovery`);
    }
    walk(h,'r_wilds_trail');h.run('GameDirector.open("hunt")');
    h.document.getElementById('hunt-mode').value='contract';h.document.getElementById('hunt-limit').value='0';h.document.getElementById('hunt-health').value='40';
    assert.equal(h.run('GameDirector.startConfiguredHunt()'),true);
    assert.equal(h.state.hunt.mode,'contract');assert.equal(h.state.hunt.healthFloor,.4);assert.equal(h.state.hunt.session.limit,2);
  } finally {h.dispose();}
});
