import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHarness, projectRoot } from './harness.mjs';
import { openingChapters, fullCampaign, guidedCampaign } from './harness-campaign.mjs';

const report = { generatedAt: null, scope: 'V11 production rules: legal authored campaign and default guided journey; no injected progression.', policy: 'Actual moves, authored choices, earned primary attributes and class talent, owned gear upgrades, nearest safe rest, visible intents, skills, overdrive and guard. No injected campaign progress, rewards, levels, victory flags, or health.', openings: [], guided: [], main: null, passedCases: [] };
let expectedCases = 0;
function verified(name, fn) {
  expectedCases++;
  test(name, async () => { await fn(); report.passedCases.push(name); });
}

verified('Every authored room and quest destination is reachable in both directions', () => {
  const h = createHarness();
  for (const id of h.json('Object.keys(WORLD_ROOMS)')) {
    assert.ok(h.json(`findShortestPath('r_town_square',${JSON.stringify(id)})`), `unreachable ${id}`);
    assert.ok(h.json(`findShortestPath(${JSON.stringify(id)},'r_town_square')`), `no route home ${id}`);
  }
  for (const entry of h.json('GameDirector.catalog().encounters')) assert.ok(h.json(`WORLD_ROOMS[${JSON.stringify(entry.room)}]`));
  const before = h.json('({player:state.player,quests:state.quests})');
  h.run('for (const q of STORY_QUESTS) claimStoryQuest(q.id)');
  assert.deepEqual(h.json('({player:state.player,quests:state.quests})'), before, 'calling claim buttons must not bypass quest conditions');
  h.dispose();
});

for (const classId of ['vanguard', 'arcanist', 'shadowblade']) {
  for (const seed of [1234, 7401, 20261022]) {
    verified(`${classId} completes chapters 1–2 legally from level 1 (seed ${seed})`, () => {
      const h = createHarness({ classId, seed });
      try {
        const result = openingChapters(h), boss = result.battles.at(-1);
        assert.ok(boss.turns <= 16, 'opening boss must be finishable in a practical number of player turns');
        assert.deepEqual(boss.phases, [1, 2]);
        assert.ok(boss.hitsTaken > 0, 'the follow-up quick attack must create real defensive pressure');
        assert.equal(boss.potionsUsed, 0);
        assert.ok(!boss.actions.some(([kind, index]) => kind === 'skill' && index === 2), 'opening does not require the third healing skill');
        assert.equal(h.state.telemetry.kills, 3);
        report.openings.push({ classId, seed, ...boss });
      } finally { h.dispose(); }
    });
  }
}

verified('Legal five-chapter Vanguard campaign, meaningful guard branches, all 23 stories and all three saved endings', () => {
  const h = createHarness({ seed: 1234 });
  try {
    const result = fullCampaign(h);
    for (const fight of result.battles.filter(fight => fight.enemyId.startsWith('boss_'))) {
      assert.ok(fight.turns <= 24, `unreasonable boss duration ${fight.enemyId}`);
      assert.deepEqual(fight.phases, [1, 2]);
    }
    assert.deepEqual(result.optionalBattle.phases, [1, 2]);
    assert.deepEqual(result.endings.map(entry => entry.ending), ['restoration', 'guardian', 'sovereign']);
    delete result.endingCheckpoint;
    report.main = result;
  } finally { h.dispose(); }
});


for (const classId of ['vanguard', 'arcanist', 'shadowblade']) {
  verified(`${classId} follows the default guided journey through 23 stories and a reachable restoration ending`, () => {
    const h=createHarness({classId,seed:1234});
    try { report.guided.push(guidedCampaign(h)); } finally { h.dispose(); }
  });
}

after(() => {
  report.generatedAt = new Date().toISOString();
  report.passed = report.passedCases.length === expectedCases;
  report.expectedCases = expectedCases;
  report.sourceSha256 = Object.fromEntries(['core', 'gameplay', 'combat', 'bootstrap'].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(projectRoot, 'src', `${name}.js`))).digest('hex')]));
  const dir = path.join(projectRoot, 'test-results'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'campaign-v11.json'), JSON.stringify(report, null, 2) + '\n');
});
