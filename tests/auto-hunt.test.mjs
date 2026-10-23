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
    h.run('toggleAutoHunt()');
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
    leveled.run('engageMob("briar_wolf"); toggleAutoHunt()');
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
    h.run('toggleAutoHunt()');
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
