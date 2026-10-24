import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { walk } from './harness-campaign.mjs';

const pauses = h => h.state.logs.filter(entry => /auto.?hunt.*paus|自动狩猎.*暂停/i.test(`${entry.text} ${entry.textZh}`));
const combatSnapshot = h => h.json('({player:state.player,combat:state.combat,telemetry:state.telemetry,quests:state.quests})');
const rewards = h => h.json('({gold:state.player.gold,xp:state.player.xp,inventory:state.player.inventory,kills:state.telemetry.kills})');
const tick = (h, count = 1) => { for (let i = 0; i < count; i++) h.run('runWorldTick()'); };

test('A real arcanist hunt pauses once instead of endlessly retrying an unaffordable retreat', () => {
  const h = createHarness({ classId: 'arcanist', seed: 1234 });
  try {
    // Reproduction uses only normal movement, rewards, level-ups and auto turns.
    walk(h, 'r_wilds_trail');
    h.run('CombatDirector.configureHunt({mode:"continuous",maxBattles:0,healthFloor:.22}); toggleAutoHunt()');
    tick(h, 130);
    assert.equal(h.state.autoHunt, false, 'low-health, low-stamina hunt must give control back');
    assert.equal(h.state.combat.inCombat, true, 'pausing must preserve the unresolved encounter');
    assert.ok(h.state.player.hp < h.state.player.maxHp * .22);
    assert.ok(h.state.player.sta < 10);
    assert.ok(h.state.telemetry.kills > 1, 'the reproduction must reach this state through actual victories');
    assert.equal(pauses(h).length, 1, 'explain the automatic pause once');
    const paused = combatSnapshot(h), logs = h.json('state.logs');
    tick(h, 20);
    assert.deepEqual(combatSnapshot(h), paused);
    assert.deepEqual(h.json('state.logs'), logs, 'a paused hunt must not repeat blocked-retreat messages');
  } finally { h.dispose(); }
});

test('A critically wounded hunter with insufficient stamina is paused without forcing a turn or reward', () => {
  const h = createHarness();
  try {
    walk(h, 'r_wilds_trail');
    h.run('engageMob("briar_wolf")');
    // Isolated boundary fixture: guarding here would kill this one-HP hero.
    h.run('state.player.hp = 1; state.player.sta = 5; toggleAutoHunt()');
    const before = combatSnapshot(h);
    tick(h);
    assert.equal(h.state.autoHunt, false);
    assert.deepEqual(combatSnapshot(h), before, 'do not spend resources, guard, flee or award a victory automatically');
    assert.equal(pauses(h).length, 1);
    const logs = h.json('state.logs');
    tick(h, 10);
    assert.deepEqual(combatSnapshot(h), before);
    assert.deepEqual(h.json('state.logs'), logs);
    assert.equal(h.run('equipOrUseItem("Minor Healing Draught")'), true, 'the player can still choose a manual recovery action');
    assert.ok(h.state.player.hp > 1);
    assert.equal(h.state.combat.enemy.round, before.combat.enemy.round + 1);
  } finally { h.dispose(); }
});

test('Low health pauses the next encounter, while a victory level-up restores eligibility to continue', () => {
  const low = createHarness();
  try {
    walk(low, 'r_wilds_trail');
    low.run('state.player.hp = 1; toggleAutoHunt()'); // Out-of-combat health boundary.
    const before = rewards(low);
    const battleSerial = low.state.combatLedger.serial;
    tick(low);
    assert.equal(low.state.autoHunt, false);
    assert.equal(low.state.combat.inCombat, false);
    assert.equal(low.state.combat.enemy, null);
    assert.equal(low.state.combatLedger.serial, battleSerial, 'do not briefly create a new enemy before pausing');
    tick(low, 9);
    assert.equal(low.state.player.hp, 1);
    assert.deepEqual(rewards(low), before);
    assert.equal(pauses(low).length, 1);
  } finally { low.dispose(); }

  const leveled = createHarness();
  try {
    walk(leveled, 'r_wilds_trail');
    leveled.run('CombatDirector.configureHunt({mode:"continuous",maxBattles:0,healthFloor:.22}); engageMob("briar_wolf"); toggleAutoHunt()');
    const firstBattle = leveled.state.combat.enemy.battleId, level = leveled.state.player.level;
    // Isolated victory boundary. The production victory/level-up rules must heal
    // before deciding whether this already-enabled hunt needs a health pause.
    leveled.run('state.player.xp = state.player.xpNext - 1; state.player.hp = 1; state.combat.enemy.hp = 1');
    assert.equal(leveled.run('CombatDirector.action("attack")'), true);
    assert.equal(leveled.state.player.level, level + 1);
    assert.ok(leveled.state.player.hp >= leveled.state.player.maxHp * .22, 'the real level-up recovery exceeds the hunting pause threshold');
    assert.equal(leveled.state.autoHunt, true);
    tick(leveled);
    assert.equal(leveled.state.combat.inCombat, true);
    assert.notEqual(leveled.state.combat.enemy.battleId, firstBattle);
    assert.equal(pauses(leveled).length, 0);
  } finally { leveled.dispose(); }
});

test('Turning hunting off stops automatic turns and later encounters while keeping manual combat usable', () => {
  const h = createHarness();
  try {
    walk(h, 'r_wilds_trail');
    h.run('toggleAutoHunt()'); tick(h);
    assert.equal(h.state.combat.inCombat, true);
    h.run('toggleAutoHunt()');
    const manual = combatSnapshot(h);
    tick(h, 4);
    assert.equal(h.state.autoHunt, false);
    assert.deepEqual(combatSnapshot(h), manual);
    for (let turn = 0; turn < 12 && h.state.combat.inCombat; turn++) {
      assert.equal(h.run('CombatDirector.action("attack")'), true);
    }
    assert.equal(h.state.combat.inCombat, false);
    assert.equal(h.state.telemetry.kills, 1);
    const won = rewards(h);
    tick(h, 10);
    assert.equal(h.state.combat.inCombat, false);
    assert.equal(h.state.combat.enemy, null);
    assert.deepEqual(rewards(h), won);
  } finally { h.dispose(); }
});

test('Healthy continuous hunting wins multiple distinct encounters without reviving an old battle', () => {
  const h = createHarness({ seed: 1234 });
  try {
    walk(h, 'r_wilds_trail');
    h.run('CombatDirector.configureHunt({mode:"continuous",maxBattles:0,healthFloor:.22}); toggleAutoHunt()');
    const battleIds = new Set();
    for (let worldTick = 0; worldTick < 30 && h.state.telemetry.kills < 3; worldTick++) {
      tick(h);
      if (h.state.combat.enemy) battleIds.add(h.state.combat.enemy.battleId);
    }
    assert.equal(h.state.telemetry.kills, 3);
    assert.equal(battleIds.size, 3);
    assert.equal(h.state.autoHunt, true);
    assert.equal(h.state.combat.inCombat, false);
    tick(h);
    assert.equal(h.state.combat.inCombat, true);
    assert.ok(!battleIds.has(h.state.combat.enemy.battleId), 'the next target must have a fresh battle identity');
    assert.equal(pauses(h).length, 0);
  } finally { h.dispose(); }
});

test('New-game hunting defaults to one victory and persists its terminal rewards without another encounter', () => {
  const h=createHarness({seed:1234});
  try {
    walk(h,'r_wilds_trail');assert.equal(h.run('toggleAutoHunt()'),true);
    tick(h,30);
    assert.equal(h.state.telemetry.kills,1);assert.equal(h.state.autoHunt,false);
    const summary=h.json('state.hunt.session');
    assert.equal(summary.status,'stopped');assert.equal(summary.stopReason,'completed');
    assert.equal(summary.limit,1);assert.equal(summary.wins,1);assert.equal(summary.xp,35);assert.equal(summary.gold,14);assert.ok(summary.loot>0);
    assert.equal(h.state.combat.inCombat,false);const before=rewards(h);tick(h,15);assert.deepEqual(rewards(h),before);
    h.run('saveGameState(false);loadGameState(false)');assert.deepEqual(h.json('state.hunt.session'),summary);assert.equal(h.state.autoHunt,false);
  } finally {h.dispose();}
});

test('Contract hunting selects the current kill contract and stops when it is ready, without claiming it', () => {
  const h=createHarness({seed:1234});
  try {
    walk(h,'r_wilds_trail');
    assert.equal(h.run('CombatDirector.configureHunt({mode:"contract",maxBattles:0,healthFloor:.22})'),true);
    assert.equal(h.run('toggleAutoHunt()'),true);tick(h,40);
    assert.equal(h.state.telemetry.kills,2);assert.equal(h.state.hunt.session.wins,2);
    assert.equal(h.state.hunt.session.stopReason,'contract_complete');assert.equal(h.state.autoHunt,false);
    const b=h.state.quests.bounties.find(b=>b.id===h.state.hunt.session.contractId);assert.equal(b.progress,b.targetKills);assert.equal(b.claimed,false);
    assert.equal(h.state.combat.inCombat,false);
  } finally {h.dispose();}
});

test('A kill-contract level requirement cannot silently turn into farming ineligible local foes', () => {
  const h=createHarness();
  try {
    walk(h,'r_wilds_trail');
    // Boundary fixture isolates contract targeting; no rewards or progression are granted.
    h.run('state.quests.bounties=[{id:"higher",desc:"Higher foes",targetKills:3,minEnemyLevel:6,progress:0,claimed:false}];CombatDirector.configureHunt({mode:"contract",maxBattles:0,healthFloor:.22})');
    const before=rewards(h);assert.equal(h.run('toggleAutoHunt()'),false);tick(h,5);
    assert.equal(h.state.combat.inCombat,false);assert.equal(h.state.autoHunt,false);assert.deepEqual(rewards(h),before);
    assert.equal(h.state.quests.bounties[0].progress,0);
  } finally {h.dispose();}
});

test('An explicitly continuous run respects a finite cap and cannot change goals while running', () => {
  const h=createHarness({seed:1234});
  try {
    walk(h,'r_wilds_trail');h.run('CombatDirector.configureHunt({mode:"continuous",maxBattles:3,healthFloor:.22});toggleAutoHunt()');
    assert.equal(h.run('CombatDirector.configureHunt({mode:"continuous",maxBattles:0,healthFloor:.22})'),false);
    assert.equal(h.run('CombatDirector.startHunt()'),false,'a repeated start cannot reset the active goal');
    tick(h,45);assert.equal(h.state.telemetry.kills,3);assert.equal(h.state.autoHunt,false);assert.equal(h.state.hunt.session.stopReason,'completed');
    assert.equal(h.state.hunt.maxBattles,3);assert.equal(h.state.hunt.session.wins,3);
  } finally {h.dispose();}
});

test('Configured health thresholds and invalid settings are enforced before starting another battle', () => {
  const h=createHarness();
  try {
    walk(h,'r_wilds_trail');h.run('CombatDirector.configureHunt({mode:"continuous",maxBattles:0,healthFloor:.6})');
    const settings=h.json('state.hunt');
    for(const config of ['{mode:"other",maxBattles:1,healthFloor:.3}','{mode:"single",maxBattles:-1,healthFloor:.3}','{mode:"single",maxBattles:1,healthFloor:NaN}','{mode:"single",maxBattles:1,healthFloor:.1}'])assert.equal(h.run(`CombatDirector.configureHunt(${config})`),false);
    assert.deepEqual(h.json('state.hunt'),settings);
    h.run('state.player.hp=Math.floor(state.player.maxHp*.5);toggleAutoHunt()');
    const before=rewards(h);tick(h,2);assert.equal(h.state.autoHunt,false);assert.equal(h.state.hunt.session.stopReason,'low_health');assert.equal(h.state.combat.inCombat,false);assert.deepEqual(rewards(h),before);
  } finally {h.dispose();}
});

test('Travel, online handoff and reloading pause the session while retaining its results', () => {
  const h=createHarness();
  try {
    walk(h,'r_wilds_trail');h.run('toggleAutoHunt();moveDirection("s")');
    assert.equal(h.state.autoHunt,false);assert.equal(h.state.hunt.session.stopReason,'moved');
    walk(h,'r_wilds_trail');h.run('toggleAutoHunt();CombatDirector.stopHunt("online")');
    assert.equal(h.state.hunt.session.stopReason,'online');assert.equal(h.state.autoHunt,false);
    h.run('toggleAutoHunt();saveGameState(false);loadGameState(false)');
    assert.equal(h.state.autoHunt,false);assert.equal(h.state.hunt.session.status,'stopped');assert.equal(h.state.hunt.session.stopReason,'reloaded');
    const before=rewards(h);tick(h,5);assert.deepEqual(rewards(h),before);
  } finally {h.dispose();}
});
