import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { walk } from './harness-campaign.mjs';

test('Manual combat advances only on player action, not the world heartbeat', () => {
  const h = createHarness(); walk(h, 'r_wilds_trail'); h.run('engageMob("briar_wolf")');
  const before = h.json('({player:state.player,combat:state.combat})');
  h.run('runWorldTick(); runWorldTick()');
  assert.deepEqual(h.json('({player:state.player,combat:state.combat})'), before);
  assert.equal(h.run('CombatDirector.action("guard")'), true);
  assert.equal(h.state.combat.enemy.round, 1);
  assert.ok(h.state.player.hp < before.player.hp);
  assert.equal(h.state.combat.enemy.hp, before.combat.enemy.hp);
  h.dispose();
});

test('Guard prevents actual damage and recovers resources compared with attacking the same state', () => {
  const h = createHarness(); walk(h, 'r_bandit_stronghold'); h.run('engageMob("boss_garrick"); CombatDirector.action("skill",0)');
  const checkpoint = h.json('state');
  h.run('CombatDirector.action("attack")'); const attacked = h.json('({hp:state.player.hp,sta:state.player.sta,enemyHp:state.combat.enemy.hp})');
  h.context.checkpoint = checkpoint; h.run('AethelgardApp.restore(checkpoint); CombatDirector.action("guard")');
  assert.ok(h.state.player.hp > attacked.hp);
  assert.ok(h.state.player.sta > attacked.sta);
  assert.ok(h.state.combat.enemy.hp > attacked.enemyHp);
  h.dispose();
});

test('Interrupting a visible charge cancels both its action and the following heavy blow', () => {
  const h = createHarness(); walk(h, 'r_bandit_stronghold');
  h.run('engageMob("boss_garrick"); CombatDirector.action("guard"); CombatDirector.action("guard")');
  assert.equal(h.state.combat.enemy.intent, 'charge');
  const hp = h.state.player.hp, stamina = h.state.player.sta;
  assert.equal(h.run('CombatDirector.action("interrupt")'), true);
  assert.equal(h.state.player.hp, hp); assert.ok(h.state.player.sta < stamina);
  assert.equal(h.state.combat.enemy.intent, 'recover');
  h.run('CombatDirector.action("attack")');
  assert.equal(h.state.player.hp, hp);
  h.dispose();
});

test('Skill cost, control and cooldown are applied; an unavailable skill consumes no turn', () => {
  const h = createHarness(); walk(h, 'r_bandit_stronghold'); h.run('engageMob("boss_garrick")');
  const hp = h.state.player.hp, sta = h.state.player.sta;
  assert.equal(h.run('useSkill(0)'), true);
  assert.equal(h.state.player.hp, hp, 'shield bash stops the announced attack');
  assert.ok(h.state.player.sta < sta); assert.ok(h.state.player.cooldowns[0] > 0);
  const used = h.json('({player:state.player,combat:state.combat})');
  assert.equal(h.run('useSkill(0)'), false);
  assert.equal(h.run('useSkill(999)'), false);
  assert.deepEqual(h.json('({player:state.player,combat:state.combat})'), used);
  h.dispose();
});

test('Potions preserve full vitals and consume an enemy turn when used in battle', () => {
  const h = createHarness(); walk(h, 'r_bandit_stronghold'); h.run('engageMob("boss_garrick")');
  const quantity = h.state.player.inventory['Minor Healing Draught'];
  assert.equal(h.run('equipOrUseItem("Minor Healing Draught")'), false);
  assert.equal(h.state.player.inventory['Minor Healing Draught'], quantity);
  h.run('CombatDirector.action("attack")');
  const round = h.state.combat.enemy.round;
  assert.equal(h.run('equipOrUseItem("Minor Healing Draught")'), true);
  assert.equal(h.state.player.inventory['Minor Healing Draught'], quantity - 1);
  assert.equal(h.state.combat.enemy.round, round + 1);
  assert.ok(h.state.player.hp < h.state.player.maxHp, 'enemy follow-up still damages the healed hero');
  h.dispose();
});

test('A completed enemy cannot grant its victory rewards again', () => {
  const h = createHarness(); walk(h, 'r_wilds_trail');
  h.run('engageMob("briar_wolf"); globalThis.completedEnemy=state.combat.enemy; CombatDirector.action("ultimate")');
  assert.equal(h.state.combat.inCombat, false); assert.equal(h.state.telemetry.kills, 1);
  const won = h.json('({player:state.player,telemetry:state.telemetry})');
  assert.equal(h.run('handleEnemyDefeated(completedEnemy)'), false);
  assert.deepEqual(h.json('({player:state.player,telemetry:state.telemetry})'), won);
  h.dispose();
});

test('Retreat ends the encounter without a victory, loot or quest progress', () => {
  const h = createHarness(); walk(h, 'r_wilds_trail');
  const before = h.json('({gold:state.player.gold,xp:state.player.xp,inventory:state.player.inventory,telemetry:state.telemetry,quests:state.quests})');
  h.run('engageMob("briar_wolf")'); assert.equal(h.run('CombatDirector.action("flee")'), true);
  assert.equal(h.state.combat.inCombat, false);
  assert.deepEqual(h.json('({gold:state.player.gold,xp:state.player.xp,inventory:state.player.inventory,telemetry:state.telemetry,quests:state.quests})'), before);
  h.dispose();
});

test('Defeat preserves equipment, drops a bounded purse and permits one recovery at its actual room', () => {
  const h = createHarness(); walk(h, 'r_wilds_trail');
  const before = h.json('({gold:state.player.gold,equipment:state.player.equipment,level:state.player.level})');
  // Extreme attacker is a combat fixture to exercise defeat, not campaign progress.
  h.run('CombatDirector.startEncounter({...MOB_TEMPLATES.briar_wolf,hp:10000,atk:100000}); CombatDirector.action("attack")');
  assert.equal(h.state.world.currentRoom, 'r_town_square'); assert.equal(h.state.combat.inCombat, false);
  assert.deepEqual(h.json('state.player.equipment'), before.equipment);
  assert.equal(h.state.player.level, before.level);
  assert.ok(h.state.player.gold < before.gold);
  assert.equal(h.run('CombatDirector.recover()'), false);
  walk(h, 'r_wilds_trail'); assert.equal(h.run('CombatDirector.recover()'), true);
  assert.equal(h.state.player.gold, before.gold);
  assert.equal(h.run('CombatDirector.recover()'), false);
  h.dispose();
});

test('Harvest costs stamina once per available node and is blocked during combat', () => {
  const h = createHarness(); walk(h, 'r_wilds_trail');
  const before = h.state.player.sta; h.run('harvestRoomNodes()');
  assert.ok(h.state.player.sta < before); assert.equal(h.state.telemetry.harvests, 1);
  const harvested = h.json('state.player'); h.run('harvestRoomNodes()');
  assert.deepEqual(h.json('state.player'), harvested);
  h.run('engageMob("briar_wolf"); harvestRoomNodes()');
  assert.deepEqual(h.json('state.player'), harvested);
  h.dispose();
});

test('The legacy free-affix argument cannot bypass forge location, payment or materials', () => {
  const h = createHarness();
  h.run('state.player.gold=200'); // isolated payment fixture
  assert.equal(h.run('rollDiabloAffixLoot(false)'), null);
  walk(h, 'r_blacksmith');
  const id = h.run('rollDiabloAffixLoot(false)');
  assert.equal(typeof id, 'string'); assert.ok(id.startsWith('gear_'));
  assert.equal(h.state.player.gold, 85); assert.ok(!h.state.player.inventory['Copper Ore']);
  assert.ok(h.state.world.proceduralItems[id]); assert.equal(h.state.player.inventory[id], 1);
  const paid = h.json('state.player'); assert.equal(h.run('rollDiabloAffixLoot(false)'), false);
  assert.deepEqual(h.json('state.player'), paid);
  h.dispose();
});

test('Crafting, refinement and equipping enforce location, ingredients and ownership', () => {
  const h = createHarness(); walk(h, 'r_wilds_trail');
  const before = h.json('state.player');
  h.run('craftRecipe("rec_heal_1"); refineEquippedGear()');
  assert.deepEqual(h.json('state.player'), before);
  assert.equal(h.run('equipOrUseItem("Crown of Eternity")'), false);
  walk(h, 'r_blacksmith');
  h.run('craftRecipe("rec_heal_1")');
  assert.equal(h.state.player.inventory['Minor Healing Draught'], before.inventory['Minor Healing Draught'] + 2);
  assert.equal(h.state.telemetry.crafted, 1);
  assert.equal(h.run('refineEquippedGear()'), true); assert.equal(h.state.player.refineLevel, 1);
  assert.equal(h.state.player.gold, 0); assert.ok(!h.state.player.inventory['Copper Ore']);
  assert.equal(h.run('refineEquippedGear()'), false); assert.equal(h.state.player.refineLevel, 1);
  h.dispose();
});

test('Tiered kill and boss contracts reject low-level enemies and accept eligible victories', () => {
  const h = createHarness(); walk(h, 'r_wilds_trail');
  h.run(`state.quests.bounties=[{id:'levelHunt',desc:'Level gate',targetKills:1,minEnemyLevel:6,progress:0,claimed:false},{id:'levelBoss',desc:'Boss gate',targetBoss:1,minEnemyLevel:6,progress:0,claimed:false}]; CombatDirector.startEncounter({...MOB_TEMPLATES.briar_wolf,hp:1,xp:0,gold:0,drops:[]}); CombatDirector.action('attack')`);
  assert.deepEqual(h.json('state.quests.bounties.map(b=>b.progress)'), [0, 0]);
  h.run(`CombatDirector.startEncounter({...MOB_TEMPLATES.briar_wolf,id:'fixture_level6',name:'Level six fixture',level:6,boss:true,hp:1,xp:0,gold:0,drops:[]}); CombatDirector.action('attack')`);
  assert.deepEqual(h.json('state.quests.bounties.map(b=>b.progress)'), [1, 1]);
  h.dispose();
});

test('An online battle locks character stance, equipment, economy, talents and solo combat', () => {
  const h = createHarness();
  h.run('OnlineRealm.isBusy=()=>true');
  const before = h.json('state.player');
  assert.equal(h.run('setStance("aggressive")'), false);
  assert.equal(h.run('allocateStat("str")'), false);
  assert.equal(h.run('learnTalent("warlord")'), false);
  assert.equal(h.run('CombatDirector.rest()'), false);
  assert.equal(h.run('equipOrUseItem("Minor Healing Draught")'), false);
  assert.equal(h.run('CombatDirector.startEncounter(MOB_TEMPLATES.briar_wolf)'), false);
  h.run('craftRecipe("rec_heal_1"); buyShopItem("Minor Healing Draught"); cycleCompanion()');
  assert.deepEqual(h.json('state.player'), before);
  assert.equal(h.state.combat.inCombat, false);
  h.dispose();
});

test('Respecialization refunds earned allocated attributes and charges only a real class change', () => {
  const h = createHarness();
  h.run('allocateStat("str"); allocateStat("str"); state.player.level=2; state.player.gold=100; selectedClassOption="arcanist"; applyCharacterConfig()');
  assert.equal(h.state.player.classId, 'arcanist'); assert.equal(h.state.player.gold, 40);
  assert.equal(h.state.player.statPoints, 2); assert.equal(h.state.player.stats.str, 6);
  const changed = h.json('state.player'); h.run('applyCharacterConfig()');
  assert.deepEqual(h.json('state.player'), changed);
  h.dispose();
});

test('A fresh hero may explore the final region but cannot turn its Star-Metal nodes into risk-free income', () => {
  const h=createHarness();
  try {
    walk(h,'r_astral_core');assert.equal(h.state.player.level,1);assert.equal(h.state.telemetry.kills,0);
    walk(h,'r_celestial_observatory');
    const before=h.json('({player:state.player,cooldowns:state.world.harvestedCooldowns,harvests:state.telemetry.harvests})');
    assert.equal(h.run('CombatDirector.harvestAccess("Star-Metal").allowed'),false);
    assert.equal(h.run('harvestRoomNodes()'),false);
    assert.deepEqual(h.json('({player:state.player,cooldowns:state.world.harvestedCooldowns,harvests:state.telemetry.harvests})'),before);
    h.run('for(let i=0;i<8;i++)runWorldTick()');assert.equal(h.run('harvestRoomNodes()'),false);
    assert.ok(!h.state.player.inventory['Star-Metal']);
  } finally {h.dispose();}
});

test('Gathering training validates level, reputation, location and payment once; completed legacy chapters also qualify', () => {
  const h=createHarness();
  try {
    // Isolated qualification/payment fixture, separate from legal campaign tests.
    h.run('state.player.level=7;state.player.rep=100;state.player.gold=500');
    const original=h.state.player.gold;assert.equal(h.run('CombatDirector.purchaseTool("astral")'),false);assert.equal(h.state.player.gold,original);
    walk(h,'r_guild_hall');assert.equal(h.run('CombatDirector.purchaseTool("bad")'),false);
    assert.equal(h.run('CombatDirector.purchaseTool("astral")'),true);assert.equal(h.state.player.gold,280);
    assert.equal(h.run('CombatDirector.purchaseTool("astral")'),false);assert.equal(h.state.player.gold,280);
    walk(h,'r_celestial_observatory');assert.equal(h.run('harvestRoomNodes()'),true);assert.equal(h.state.player.inventory['Star-Metal'],1);
    h.run('delete state.director.guildTools.astral;state.quests.completed.push("q4_titan_forge")');
    assert.equal(h.run('CombatDirector.harvestAccess("Star-Metal").allowed'),true,'a migrated completed chapter is sufficient preparation');
  } finally {h.dispose();}
});

test('Shard exchange guarantees the selected set and slot, with atomic rejection and real currency costs', () => {
  const h=createHarness();
  try {
    h.run('state.player.level=4;state.player.rep=75;state.player.gold=500;state.player.shards=16');
    const snapshot=()=>h.json('({gold:state.player.gold,shards:state.player.shards,inventory:state.player.inventory,items:state.world.proceduralItems})');
    let before=snapshot();assert.equal(h.run('CombatDirector.redeemSet("weapon","stormcaller")'),false);assert.deepEqual(snapshot(),before);
    walk(h,'r_guild_hall');
    for(const call of ['CombatDirector.redeemSet("bag","stormcaller")','CombatDirector.redeemSet("weapon","missing")']) {before=snapshot();assert.equal(h.run(call),false);assert.deepEqual(snapshot(),before);}
    const offer=h.json('CombatDirector.getGuildContext().exchange'),gold=h.state.player.gold;
    const id=h.run('CombatDirector.redeemSet("relic","singularity")');assert.equal(typeof id,'string');
    assert.equal(h.run(`ITEM_CATALOG[${JSON.stringify(id)}].slot`),'relic');assert.equal(h.run(`ITEM_CATALOG[${JSON.stringify(id)}].setId`),'singularity');
    assert.equal(h.state.player.inventory[id],1);assert.equal(h.state.player.gold,gold-offer.gold);assert.equal(h.state.player.shards,16-offer.shards);
    h.run('state.player.shards=0');before=snapshot();assert.equal(h.run('CombatDirector.redeemSet("relic","singularity")'),false);assert.deepEqual(snapshot(),before);
    h.run('saveGameState(false);loadGameState(false)');assert.equal(h.state.player.inventory[id],1);assert.equal(h.run(`ITEM_CATALOG[${JSON.stringify(id)}].setId`),'singularity');
  } finally {h.dispose();}
});

test('Guild rank changes actual merchant prices and advertised prices together', () => {
  const h=createHarness();
  try {
    h.run('state.player.rep=150;renderAll()');
    const offer=h.json('CombatDirector.getGuildContext()'),price=h.run('CombatDirector.shopPrice("Minor Healing Draught")'),gold=h.state.player.gold,qty=h.state.player.inventory['Minor Healing Draught'];
    assert.equal(offer.rank.index,3);assert.equal(offer.discountPercent,15);assert.equal(price,17);
    assert.ok(h.document.getElementById('shop-list').innerHTML.includes('17g'));
    assert.equal(h.run('buyShopItem("Minor Healing Draught")'),true);assert.equal(h.state.player.gold,gold-price);assert.equal(h.state.player.inventory['Minor Healing Draught'],qty+1);
  } finally {h.dispose();}
});

test('Companion training is paid, bounded, stale-click-safe and reflected in both damage growth and the visible level', () => {
  const h=createHarness();
  try {
    h.run('state.player.level=5;state.player.rep=75;state.player.gold=500;state.player.shards=20');walk(h,'r_guild_hall');
    const offer=h.json('CombatDirector.getGuildContext().training');assert.equal(offer.level,1);
    assert.equal(h.run('CombatDirector.trainCompanion(1)'),true);assert.equal(h.state.fun.companionLevel,2);
    assert.equal(h.state.player.gold,500-offer.gold);assert.equal(h.state.player.shards,20-offer.shards);
    const paid=h.json('({player:state.player,fun:state.fun})');assert.equal(h.run('CombatDirector.trainCompanion(1)'),false);assert.deepEqual(h.json('({player:state.player,fun:state.fun})'),paid);
    assert.ok(h.document.getElementById('btn-cycle-companion').textContent.includes('Lv.2'));
    assert.equal(h.run('CombatDirector.getContext().companion.trainingBonusPercent'),.5);
    h.run('saveGameState(false);loadGameState(false)');assert.equal(h.state.fun.companionLevel,2);
    h.run('state.fun.companionLevel=7');assert.equal(h.run('CombatDirector.trainCompanion(7)'),false,'hero level + 2 bounds further training');
  } finally {h.dispose();}
});

test('Guild services cannot alter rewards or currencies during solo battles, online locks or save read-only mode', () => {
  const h=createHarness();
  try {
    walk(h,'r_guild_hall');h.run('state.player.level=7;state.player.rep=150;state.player.gold=1000;state.player.shards=50;CombatDirector.startEncounter(MOB_TEMPLATES.briar_wolf)');
    const snapshot=()=>h.json('({player:state.player,fun:state.fun,tools:state.director.guildTools})');
    let before=snapshot();
    for(const call of ['CombatDirector.redeemSet("weapon","stormcaller")','CombatDirector.trainCompanion(1)','CombatDirector.purchaseTool("astral")'])assert.equal(h.run(call),false);
    assert.deepEqual(snapshot(),before);
    h.run('CombatDirector.action("flee");OnlineRealm.isBusy=()=>true');before=snapshot();
    for(const call of ['CombatDirector.redeemSet("weapon","stormcaller")','CombatDirector.trainCompanion(1)','CombatDirector.purchaseTool("astral")'])assert.equal(h.run(call),false);
    assert.deepEqual(snapshot(),before);
    h.run('OnlineRealm.isBusy=()=>false;window.AethelgardApp={...window.AethelgardApp,canWrite:()=>false}');before=snapshot();
    assert.equal(h.run('CombatDirector.trainCompanion(1)'),false);assert.equal(h.run('CombatDirector.purchaseTool("astral")'),false);assert.deepEqual(snapshot(),before);
  } finally {h.dispose();}
});

test('Defensive stance trades away spell damage as well as physical attack for its defense', () => {
  const samples={};
  for(const stance of ['balanced','defensive']) {
    const h=createHarness({classId:'arcanist',seed:1234});
    try {
      h.run(`CombatDirector.rest();setStance(${JSON.stringify(stance)})`);walk(h,'r_wilds_trail');
      const d=h.json('computeDerivedStats()');h.run('engageMob("briar_wolf");CombatDirector.action("attack")');
      samples[stance]={...d,enemyHp:h.state.combat.enemy.hp,hp:h.state.player.hp};
    } finally {h.dispose();}
  }
  assert.ok(samples.defensive.def>samples.balanced.def);assert.ok(samples.defensive.mag<samples.balanced.mag);
  assert.ok(samples.defensive.enemyHp>samples.balanced.enemyHp);assert.ok(samples.defensive.hp>=samples.balanced.hp);
});

test('Shared interrupt effects match both spell interruption and charge interruption across a boss phase change', () => {
  const caster=createHarness();
  try {
    walk(caster,'r_mushroom_grove');caster.run('engageMob("sporeling_mystic")');
    assert.equal(caster.state.combat.enemy.intent,'cast');const effect=caster.json('CombatDirector.getContext().decisions.interrupt.effect');
    assert.equal(effect.cancelsCurrentAction,true);assert.equal(effect.exposesNextTurn,false);assert.equal(effect.nextIntent,null);
    caster.run('CombatDirector.action("interrupt")');assert.equal(caster.state.combat.enemy.intent,'strike');
  } finally {caster.dispose();}
  const h=createHarness();
  try {
    walk(h,'r_bandit_stronghold');h.run('engageMob("boss_garrick");CombatDirector.action("guard");CombatDirector.action("guard")');
    assert.equal(h.state.combat.enemy.intent,'charge');
    h.run('state.combat.enemy.hp=Math.floor(state.combat.enemy.maxHp*.5)+1'); // Phase-boundary fixture.
    const effect=h.json('CombatDirector.getContext().decisions.interrupt.effect');assert.equal(effect.exposesNextTurn,true);assert.equal(effect.nextIntent,'recover');
    h.run('CombatDirector.action("interrupt")');assert.equal(h.state.combat.enemy.phase,2);assert.equal(h.state.combat.enemy.intent,'recover');
  } finally {h.dispose();}
});
