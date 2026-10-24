import assert from 'node:assert/strict';

// All progression below calls the production rules. Only the starting class and
// random seed are fixtures. No levels, items, flags, victories or gold are injected.
export function walk(h, target) {
  const route = h.json(`findShortestPath(state.world.currentRoom, ${JSON.stringify(target)})`);
  assert.ok(route, `No real route to ${target}`);
  for (const direction of route) assert.equal(h.run(`moveDirection(${JSON.stringify(direction)})`), true, `Cannot walk ${direction} to ${target}`);
  assert.equal(h.state.world.currentRoom, target);
}

export function event(h, id, index = 0) {
  const entry = h.json(`GameDirector.catalog().encounters.find(e => e.id === ${JSON.stringify(id)})`);
  assert.ok(entry, `Unknown authored encounter ${id}`);
  walk(h, entry.room);
  const opened = h.run(`GameDirector.startEncounter(${JSON.stringify(id)})`);
  assert.equal(opened.ok, true, `${id} cannot open: ${opened.reason}`);
  const result = h.run(`GameDirector.resolveChoice(${index})`);
  assert.equal(result.ok, true, `${id}/${index} blocked: ${result.reason}`);
  h.run('GameDirector.close()');
  return JSON.parse(JSON.stringify(result));
}

export function restNearest(h, returnToOrigin = true) {
  const origin = h.state.world.currentRoom;
  const nearest = h.json(`Object.values(WORLD_ROOMS).filter(r => r.safe).map(r => ({id:r.id,path:findShortestPath(state.world.currentRoom,r.id)})).filter(r=>r.path).sort((a,b)=>a.path.length-b.path.length)[0]`);
  assert.ok(nearest);
  walk(h, nearest.id);
  assert.equal(h.run('CombatDirector.rest()'), true);
  if (returnToOrigin) walk(h, origin);
}

export function equipOwnedUpgrades(h) {
  const best = h.json(`(() => {
    const p=state.player, out=[];
    const score=i=>i ? (p.classId==='arcanist' ? (i.mag||0) : (i.atk||0))*2+(i.def||0)+(i.crit||0) : 0;
    for(const slot of ['weapon','armor','helm','ring','relic']) {
      const current=p.equipment[slot];
      const ids=Object.keys(p.inventory).filter(id=>p.inventory[id]>0&&ITEM_CATALOG[id]?.type==='equipment'&&ITEM_CATALOG[id].slot===slot&&!(ITEM_CATALOG[id].requiredLevel>p.level));
      ids.sort((a,b)=>score(ITEM_CATALOG[b])-score(ITEM_CATALOG[a]));
      if(ids[0]&&score(ITEM_CATALOG[ids[0]])>score(ITEM_CATALOG[current]))out.push(ids[0]);
    }
    return out;
  })()`);
  for (const id of best) assert.equal(h.run(`equipOrUseItem(${JSON.stringify(id)})`), true);
}

export function spendEarnedPoints(h) {
  const key = { vanguard: 'str', arcanist: 'int', shadowblade: 'agi' }[h.state.player.classId];
  while (h.state.player.statPoints > 0) assert.equal(h.run(`allocateStat(${JSON.stringify(key)})`), true);
  const talent = h.state.player.classId === 'arcanist' ? 'mystic' : 'warlord';
  while (h.state.player.talentPoints > 0 && h.state.player.talents[talent] < 5) assert.equal(h.run(`learnTalent(${JSON.stringify(talent)})`), true);
}

export function observeVitals(h) {
  const player = h.state.player;
  const metrics = { lowestHp: player.hp, lowestSta: player.sta, damageTaken: 0, hitsTaken: 0 };
  const descriptors = {};
  for (const key of ['hp', 'sta']) {
    descriptors[key] = Object.getOwnPropertyDescriptor(player, key);
    let current = player[key];
    Object.defineProperty(player, key, {
      configurable: true, enumerable: true,
      get: () => current,
      set(next) {
        if (key === 'hp') {
          metrics.lowestHp = Math.min(metrics.lowestHp, next);
          if (next < current) { metrics.damageTaken += current - next; metrics.hitsTaken++; }
        } else metrics.lowestSta = Math.min(metrics.lowestSta, next);
        current = next;
      }
    });
  }
  return { metrics, restore() {
    for (const key of ['hp', 'sta']) {
      const value = player[key];
      Object.defineProperty(player, key, { ...descriptors[key], value });
    }
  } };
}

export function fight(h, enemyId, { maxTurns = 60, allowHealingSkill = true } = {}) {
  assert.equal(h.run(`engageMob(${JSON.stringify(enemyId)})`), true, `Cannot engage ${enemyId} at ${h.state.world.currentRoom}`);
  const start = h.json('({level:state.player.level,maxHp:state.player.maxHp,hp:state.player.hp,enemyHp:state.combat.enemy.maxHp,enemyAttack:state.combat.enemy.atk})');
  const observation = observeVitals(h), phases = new Set(), actions = [];
  let potionsUsed = 0;
  try {
    while (h.state.combat.inCombat && actions.length < maxTurns) {
      const c = h.json('CombatDirector.getContext()'), p = h.state.player;
      if (c.enemy.phase) phases.add(c.enemy.phase);
      let action = ['attack'];
      const healing = c.skills[2];
      if (p.hp < p.maxHp * .35 && allowHealingSkill && healing.available) action = ['skill', 2];
      else if (p.hp < p.maxHp * .30 && (p.inventory['Greater Healing Elixir'] || p.inventory['Minor Healing Draught'])) {
        action = ['potion', p.inventory['Greater Healing Elixir'] ? 'Greater Healing Elixir' : 'Minor Healing Draught']; potionsUsed++;
      } else if (['cast', 'charge'].includes(c.enemy.intent) && p.sta >= 18) action = ['interrupt'];
      else if (c.enemy.intent === 'heavy') action = ['guard'];
      else if (c.player.overdrive >= 50) action = ['ultimate'];
      else if (c.skills[0].available) action = ['skill', 0];
      else if (c.skills[1].available) action = ['skill', 1];
      else if (p.sta < 18 || (p.classId === 'arcanist' && p.mp < 16)) action = ['guard'];
      assert.equal(h.run(`CombatDirector.action(${action.map(value => JSON.stringify(value)).join(',')})`), true, `Rejected turn ${enemyId}: ${action}`);
      actions.push(action);
    }
    assert.equal(h.state.combat.inCombat, false, `${enemyId} did not finish within ${maxTurns} turns`);
    assert.ok(h.state.world.currentRoom !== 'r_town_square', `${enemyId} defeated the hero`);
    if (enemyId.startsWith('boss_')) assert.ok(h.state.world.defeatedBosses.includes(enemyId), `Missing victory ${enemyId}`);
    return { enemyId, ...start, turns: actions.length, ...observation.metrics, potionsUsed, phases: [...phases], actions };
  } finally { observation.restore(); }
}

export function compareFollowupDefense(h, enemyId, openingActions) {
  const before = h.json('state');
  try {
    assert.equal(h.run(`engageMob(${JSON.stringify(enemyId)})`), true);
    for (const action of openingActions) assert.equal(h.run(`CombatDirector.action(${action.map(x => JSON.stringify(x)).join(',')})`), true);
    const checkpoint = h.json('state'), results = {};
    for (const action of ['attack', 'guard']) {
      h.context.checkpointToRestore = checkpoint;
      h.run('AethelgardApp.restore(checkpointToRestore)');
      const p = h.state.player, hp = p.hp, sta = p.sta, enemyHp = h.state.combat.enemy.hp;
      assert.equal(h.run(`CombatDirector.action(${JSON.stringify(action)})`), true);
      results[action] = { hpLost: hp - p.hp, staminaRecovered: p.sta - sta, damageDealt: enemyHp - h.state.combat.enemy.hp };
    }
    assert.ok(results.guard.hpLost < results.attack.hpLost, `${enemyId}: defense must prevent actual HP loss`);
    assert.ok(results.guard.staminaRecovered > results.attack.staminaRecovered, `${enemyId}: defense must recover more stamina`);
    assert.ok(results.attack.damageDealt > results.guard.damageDealt, `${enemyId}: attacking must retain an offensive benefit`);
    return { enemyId, ...results };
  } finally {
    h.context.checkpointToRestore = before;
    h.run('AethelgardApp.restore(checkpointToRestore)');
    delete h.context.checkpointToRestore;
  }
}

export function openingChapters(h, { compareDefense = false } = {}) {
  const battles = [], choices = [];
  assert.equal(h.state.player.level, 1);
  spendEarnedPoints(h); restNearest(h);
  event(h, 'first_oath', 0);
  walk(h, 'r_wilds_trail');
  h.run('harvestRoomNodes()');
  battles.push(fight(h, 'briar_wolf', { allowHealingSkill: false }));
  battles.push(fight(h, 'briar_wolf', { allowHealingSkill: false }));
  assert.ok(h.state.quests.completed.includes('q1_wilds'));
  equipOwnedUpgrades(h); spendEarnedPoints(h);
  event(h, 'wounded_scout', 0);
  event(h, 'elara_plan', 0);
  restNearest(h);
  walk(h, 'r_bandit_stronghold');
  if (compareDefense) choices.push(compareFollowupDefense(h, 'boss_garrick', [['skill', 0]]));
  battles.push(fight(h, 'boss_garrick', { allowHealingSkill: false }));
  assert.deepEqual(h.json('state.quests.completed'), ['q1_wilds', 'q2_bandit_king']);
  return { battles, choices };
}

export function fullCampaign(h) {
  const result = openingChapters(h, { compareDefense: true });
  event(h, 'bandit_ledger', 0); h.run('harvestRoomNodes()');
  event(h, 'tavern_courier', 0);
  walk(h, 'r_old_mill'); h.run('harvestRoomNodes()'); event(h, 'mill_wheel', 0);
  event(h, 'menhir_root', 0); h.run('harvestRoomNodes()');
  event(h, 'brom_apprentice', 0);
  event(h, 'river_cart', 0); h.run('harvestRoomNodes()');
  equipOwnedUpgrades(h); spendEarnedPoints(h); restNearest(h);
  event(h, 'bone_ferry', 1);
  // Studying the formula allows the third ending without forfeiting any seal.
  event(h, 'vesper_names', 1);
  event(h, 'forbidden_page', 1); h.run('harvestRoomNodes()');
  event(h, 'memory_bell', 0); h.run('harvestRoomNodes()');
  equipOwnedUpgrades(h); spendEarnedPoints(h); restNearest(h);
  walk(h, 'r_lich_sanctum');
  result.choices.push(compareFollowupDefense(h, 'boss_malakor', [['interrupt'], ['skill', 0]]));
  result.battles.push(fight(h, 'boss_malakor'));
  assert.ok(h.state.quests.completed.includes('q3_sunken_lich'));
  event(h, 'freed_souls', 0); h.run('harvestRoomNodes()');
  event(h, 'borin_valves', 0); restNearest(h);
  event(h, 'furnace_fire', 0);
  event(h, 'bridge_rescue', 0);
  event(h, 'geode_echo', 0);
  equipOwnedUpgrades(h); spendEarnedPoints(h); restNearest(h);
  walk(h, 'r_caldera_throne');
  result.battles.push(fight(h, 'boss_ignis_vulcan'));
  assert.ok(h.state.quests.completed.includes('q4_titan_forge'));
  event(h, 'rift_anchor', 0); h.run('harvestRoomNodes()');
  event(h, 'chrono_self', 0);
  event(h, 'observatory_lens', 0);
  event(h, 'conduit_choice', 0);
  equipOwnedUpgrades(h); spendEarnedPoints(h); restNearest(h);
  walk(h, 'r_throne_approach');
  const beforeOptional = h.json('state');
  result.optionalBattle = fight(h, 'boss_vaelen');
  h.context.optionalCheckpoint = beforeOptional; h.run('AethelgardApp.restore(optionalCheckpoint)'); delete h.context.optionalCheckpoint;
  walk(h, 'r_astral_core');
  result.battles.push(fight(h, 'boss_xalkorath'));
  assert.equal(h.state.quests.completed.length, 5);
  assert.equal(Object.keys(h.state.director.completed).length, 22);
  result.endingCheckpoint = h.json('state');
  result.endings = [];
  for (const [index, ending] of ['restoration', 'guardian', 'sovereign'].entries()) {
    h.context.endingCheckpoint = result.endingCheckpoint; h.run('AethelgardApp.restore(endingCheckpoint)');
    event(h, 'final_choice', index);
    assert.equal(h.state.director.ending, ending);
    assert.equal(Object.keys(h.state.director.completed).length, 23);
    const rewards = h.json('({xp:state.player.xp,gold:state.player.gold,shards:state.player.shards,level:state.player.level})');
    h.run('saveGameState(false); loadGameState(false)');
    assert.equal(h.run('GameDirector.startEncounter("final_choice").ok'), false);
    assert.deepEqual(h.json('({xp:state.player.xp,gold:state.player.gold,shards:state.player.shards,level:state.player.level})'), rewards);
    result.endings.push({ ending, level: h.state.player.level });
  }
  delete h.context.endingCheckpoint;
  return result;
}

// V11 route test: use the actual recommended journey step and the live tactical
// button. We choose authored options, gather permitted nodes along the route,
// spend earned points and legally walk to settlements for recovery.
export function guidedCampaign(h) {
  const preferred={first_oath:0,tavern_courier:0,wounded_scout:0,brom_apprentice:1,mill_wheel:2,menhir_root:0,elara_plan:0,bandit_ledger:0,river_cart:0,bone_ferry:1,vesper_names:0,forbidden_page:1,memory_bell:0,freed_souls:0,borin_valves:1,furnace_fire:0,bridge_rescue:0,geode_echo:0,rift_anchor:0,chrono_self:0,observatory_lens:0,conduit_choice:0,final_choice:0};
  const events=[],battles=[];let steps=0,activeBattle=null;
  spendEarnedPoints(h);restNearest(h);
  while(!h.state.director?.ending && steps++<450) {
    if(h.state.combat.inCombat) {
      if(!activeBattle)activeBattle={id:h.state.combat.enemy.id,turns:0,kills:h.state.telemetry.kills};
      h.run('renderAll()');
      assert.ok(h.json('CombatDirector.getContext().decisions.recommendedAction'),'combat should have a legal recommendation');
      h.document.getElementById('btn-proceed-next-step').click();activeBattle.turns++;
      assert.ok(activeBattle.turns<65,'a guided battle must make progress');
      if(!h.state.combat.inCombat) {
        assert.ok(h.state.telemetry.kills>activeBattle.kills,`guided battle ended without victory: ${activeBattle.id}`);
        battles.push({id:activeBattle.id,turns:activeBattle.turns});activeBattle=null;
        equipOwnedUpgrades(h);spendEarnedPoints(h);restNearest(h);
      }
      continue;
    }
    if(h.state.director.pending) {
      const id=h.state.director.pending.id,index=preferred[id];assert.ok(Number.isInteger(index),`Unexpected story ${id}`);
      const result=h.run(`GameDirector.resolveChoice(${index})`);
      assert.equal(result.ok,true,`${id} choice blocked: ${result.reason}`);events.push(id);
      h.run('GameDirector.close()');equipOwnedUpgrades(h);spendEarnedPoints(h);restNearest(h);continue;
    }
    const harvestable=h.run(`(WORLD_ROOMS[state.world.currentRoom].nodes||[]).some(n=>!state.world.harvestedCooldowns[state.world.currentRoom+':'+n.id]&&CombatDirector.harvestAccess(n.item).allowed)`);
    if(harvestable)h.run('harvestRoomNodes()');
    h.run('GameDirector.followObjective()');
  }
  assert.ok(steps<450,'guidance must not loop or strand a player');
  assert.equal(h.state.quests.completed.length,5);assert.equal(h.state.director.ending,'restoration');
  assert.equal(events.length,23);assert.equal(new Set(events).size,23);
  return {classId:h.state.player.classId,level:h.state.player.level,steps,events,battles,ending:h.state.director.ending};
}
