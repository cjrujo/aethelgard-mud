import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePassport, PROTOCOL, LIMITS, default as worker } from '../cloudflare-worker/worker.js';
import { realmHarness, clientHarness, readyClient, connectClient, sendAction, passport, identity, ackPacket } from './online-harness.mjs';

test('v11 handshake validates passports, recovery identity and upgrade diagnostics', async t => {
  const h = realmHarness(t), a = await h.add({}, false);
  assert.equal(a.ws.last('welcome').protocol, 11); assert.ok(a.ws.last('welcome').build.id);
  await a.ws.receive({ type: 'hello', protocol: 10, passport: passport() });
  assert.equal(a.ws.all('ready').length, 0); assert.match(a.ws.last('error').messageZh, /11/);
  await a.ws.receive({ type: 'hello', protocol: PROTOCOL, passport: passport({ classId: 'admin' }), identity: a.identity });
  assert.equal(a.ws.last('error').code, 'passport');
  await a.ws.receive({ type: 'hello', protocol: PROTOCOL, passport: passport() });
  assert.equal(a.ws.last('error').code, 'identity');
  await a.ws.receive({ type: 'hello', protocol: PROTOCOL, sessionId: 'forged', passport: passport({ atk: 1e9, maxHp: 1e9 }), identity: a.identity });
  assert.equal(a.ws.last('ready').sessionId, a.id); assert.equal(a.session.passport.atk, 120); assert.equal(a.session.passport.maxHp, 800);
  assert.equal(a.ws.last('ready').heroId, a.identity.heroId);
  const serialized = JSON.stringify([...h.storage.data]);
  assert.ok(!serialized.includes(a.identity.token));
  assert.throws(() => validatePassport(passport({ atk: Infinity })), /finite/);
  assert.throws(() => validatePassport(passport({ room: '../private' })), /room/);
});

test('presence and room chat use the actual socket identity and hide recovery credentials', async t => {
  const h = realmHarness(t), a = await h.add({ alias: 'Alice' }), b = await h.add({ alias: 'Bob' }), c = await h.add({ room: 'r_tavern' });
  assert.equal(a.ws.last('presence').players.length, 3);
  await a.ws.receive({ type: 'chat', text: 'Hello', sessionId: b.id, alias: 'Bob', room: 'r_tavern' });
  assert.equal(b.ws.last('chat').alias, 'Alice'); assert.equal(b.ws.last('chat').sessionId, a.id);
  assert.equal(c.ws.all('chat').length, 0);
  assert.ok(!JSON.stringify(b.ws.messages).includes(a.identity.token));
  await a.ws.receive({ type: 'chat', text: 'Too fast' }); assert.equal(a.ws.last('error').code, 'chat_rate');
  await b.ws.close(); await h.server.idle(); assert.equal(a.ws.last('presence').players.length, 2);
});

test('raid lobby requires real room companions and the leader, and locks its passport', async t => {
  const h = realmHarness(t), a = await h.add(), b = await h.add(), elsewhere = await h.add({ room: 'r_tavern' });
  await a.ws.receive({ type: 'raid_join' }); await a.ws.receive({ type: 'raid_start' }); assert.equal(a.ws.last('error').code, 'players');
  await elsewhere.ws.receive({ type: 'raid_join' }); assert.notEqual(elsewhere.session.battleId, a.session.battleId);
  await b.ws.receive({ type: 'raid_join' }); await b.ws.receive({ type: 'raid_start' }); assert.equal(b.ws.last('error').code, 'leader');
  await a.ws.receive({ type: 'raid_start' });
  const battle = h.server.battles.get(a.session.battleId); assert.equal(battle.status, 'active'); assert.ok(battle.boss.hp > 0);
  assert.equal(a.ws.all('battle_result').length, 0);
  const before = { ...a.session.passport };
  await a.ws.receive({ type: 'sync', passport: passport({ room: 'r_tavern', atk: 120 }) });
  assert.deepEqual(a.session.passport, before); assert.equal(a.ws.last('error').code, 'busy');
});

test('real raid actions win, persist one receipt per participant, and acknowledge idempotently', async t => {
  const h = realmHarness(t), players = [await h.add({ alias: 'A' }), await h.add({ alias: 'B' })];
  for (const p of players) await p.ws.receive({ type: 'raid_join' });
  await players[0].ws.receive({ type: 'raid_start' }); const b = h.server.battles.get(players[0].session.battleId);
  for (let step = 0; step < 30 && b.status === 'active'; step++) {
    h.clock.elapse(1000);
    for (const p of players) {
      const m = b.members.find(m => m.id === p.id); if (m.hp <= 0 || b.status !== 'active') continue;
      const action = m.hp < m.maxHp * .4 && m.heals ? 'heal' : !m.skillCd ? 'skill' : b.boss.intent === 'focus' && b.boss.targetId === m.id ? 'guard' : 'attack';
      await sendAction(p, b, action);
    }
  }
  assert.equal(b.status, 'finished'); assert.equal(b.boss.hp, 0);
  for (const p of players) {
    const r = p.ws.last('battle_result'); assert.equal(r.outcome, 'victory'); assert.equal(r.eligible, true); assert.ok(r.reward.loot);
    assert.equal((await h.storage.get(p.session.ownerKey)).pending.length, 1);
    assert.equal(r.rewardId, `${r.ledgerId}:1`);
    await p.ws.receive(ackPacket(r)); await p.ws.receive(ackPacket(r));
    assert.equal((await h.storage.get(p.session.ownerKey)).pending.length, 0);
  }
  await h.server.finish(b, 0); assert.equal(players[0].ws.all('battle_result').length, 1);
});

test('timeout auto-guard does not count as a contribution', async t => {
  const h = realmHarness(t), active = await h.add({ atk: 120, mag: 120, def: 60, maxHp: 800 }), idle = await h.add({ atk: 8, mag: 8, def: 60, maxHp: 800 });
  await active.ws.receive({ type: 'raid_join' }); await idle.ws.receive({ type: 'raid_join' }); await active.ws.receive({ type: 'raid_start' });
  const b = h.server.battles.get(active.session.battleId);
  for (let round = 0; round < 30 && b.status === 'active'; round++) {
    await active.ws.receive({ type: 'ping' }); await idle.ws.receive({ type: 'ping' });
    await sendAction(active, b, b.members.find(m => m.id === active.id).skillCd ? 'attack' : 'skill');
    await h.clock.run(LIMITS.roundMs);
  }
  assert.equal(b.boss.hp, 0); assert.equal(b.members.find(m => m.id === idle.id).contribution, 0);
  assert.equal(idle.ws.last('battle_result').eligible, false); assert.equal(idle.ws.last('battle_result').reward.gold, 0);
});

test('3v3 waits for six distinct saved heroes and duplicate queues cannot create teammates', async t => {
  const h = realmHarness(t), players = [];
  for (let i = 0; i < 6; i++) players.push(await h.add({ alias: `P${i}`, atk: i ? 9 : 1e8, maxHp: i ? 80 : 1e8 }));
  for (const p of players.slice(0, 5)) await p.ws.receive({ type: 'arena_queue', mode: 'team' });
  await players[0].ws.receive({ type: 'arena_queue', mode: 'team' });
  assert.equal(h.server.queues.team.length, 5); assert.equal(h.server.battles.size, 0);
  await players[5].ws.receive({ type: 'arena_queue', mode: 'team' });
  const b = h.server.battles.get(players[0].session.battleId);
  assert.equal(b.members.length, 6); assert.equal(b.members.filter(m => m.team === 0).length, 3);
  assert.equal(b.members[0].maxHp, b.members[1].maxHp); assert.equal(b.members[0].atk, b.members[1].atk);
  const reconnect = await h.add({ alias: 'P0' }, true, players[0].identity);
  assert.equal(players[0].ws.last('error').code, 'session_replaced'); assert.ok(reconnect.session.ready);
});

test('arena rejects invalid targets, extra actions, expired rounds and cooldown skills', async t => {
  const h = realmHarness(t), a = await h.add(), b = await h.add();
  await a.ws.receive({ type: 'arena_queue', mode: 'duel' }); await b.ws.receive({ type: 'arena_queue', mode: 'duel' });
  const battle = h.server.battles.get(a.session.battleId), first = battle.members[0], second = battle.members[1];
  await sendAction(a, battle, 'attack', a.id); assert.equal(first.action, null); assert.equal(a.ws.last('error').code, 'target');
  await a.ws.receive({ type: 'battle_action', battleId: battle.id, round: 1, action: 'skill', targetId: b.id, sessionId: b.id });
  assert.equal(first.contribution, 1); assert.equal(second.contribution, 0);
  await sendAction(a, battle, 'attack', b.id); assert.equal(a.ws.last('error').code, 'already_acted');
  await sendAction(b, battle, 'guard'); assert.equal(battle.round, 2); assert.ok(second.hp < second.maxHp); assert.equal(first.skillCd, 2);
  await sendAction(a, battle, 'skill', b.id); assert.equal(a.ws.last('error').code, 'cooldown');
  await a.ws.receive({ type: 'battle_action', battleId: battle.id, round: 1, action: 'attack', targetId: b.id }); assert.equal(a.ws.last('error').code, 'battle_state');
});

test('forfeit, idle cleanup and queue expiry do not reward joining or waiting', async t => {
  const h = realmHarness(t), a = await h.add(), b = await h.add();
  await a.ws.receive({ type: 'arena_queue', mode: 'duel' }); await b.ws.receive({ type: 'arena_queue', mode: 'duel' });
  await b.ws.close(); await h.server.idle(); assert.equal(a.ws.last('battle_result').outcome, 'victory'); assert.equal(a.ws.last('battle_result').eligible, false);
  await a.ws.receive({ type: 'arena_queue', mode: 'team' });
  h.clock.elapse(LIMITS.queueMs + 1); await a.ws.receive({ type: 'ping' }); await h.server.sweep();
  assert.equal(a.session.queueMode, null); assert.equal(a.ws.last('error').code, 'queue_timeout');
  h.clock.elapse(LIMITS.idleMs + 1); await h.server.sweep(); assert.equal(h.server.sessions.size, 0);
});

test('server packet/rate and HTTP origin/realm boundaries include build diagnostics', async t => {
  const h = realmHarness(t), a = await h.add(), b = await h.add();
  await a.ws.receive('x'.repeat(LIMITS.packet + 1)); assert.equal(a.ws.closeCode, 1009);
  for (let i = 0; i < 46; i++) await b.ws.receive({ type: 'ping' }); assert.equal(b.ws.closeCode, 1008);
  const env = { ALLOWED_ORIGINS: 'https://game.example', AETHELGARD_REALM: { idFromName: x => x, get: () => h.server } };
  assert.equal((await worker.fetch(new Request('https://realm.example/?realm=bad%2Fname'), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://realm.example/', { method: 'POST' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request('https://realm.example/', { headers: { Upgrade: 'websocket', Origin: 'https://untrusted.example' } }), env)).status, 403);
  const health = await (await worker.fetch(new Request('https://realm.example/health'), env)).json();
  assert.equal(health.protocol, 11); assert.ok(health.build.id); assert.equal(health.durableReceipts, true); assert.equal(health.onlinePlayers, 0);
});

test('client verifies handshake, current session/hero and receipt types, then saves only once', t => {
  const { h, sockets } = clientHarness(t); h.run('OnlineRealm.connect()'); const ws = sockets[0];
  ws.receive({ type: 'ready', protocol: 11, sessionId: 'self' }); assert.equal(h.json('OnlineRealm.getStatus()').status, 'connecting');
  readyClient(h, ws); assert.equal(h.json('OnlineRealm.getStatus()').status, 'live');
  const gold = h.state.player.gold;
  const result = { type: 'battle_result', battleId: 'b-test', kind: 'arena', ledgerId: 'l-test', sequence: 1, rewardId: 'l-test:1', sessionId: 'self', heroId: h.state.online.heroId, outcome: 'victory', eligible: true, reward: { gold: 35, xp: 0, shards: 1, glory: 4, loot: false } };
  ws.receive({ ...result, sessionId: 'someone-else' }); ws.receive({ ...result, heroId: identity().heroId }); ws.receive({ ...result, reward: { ...result.reward, gold: 1001 } });
  assert.equal(h.state.player.gold, gold); ws.receive(result); ws.receive(result);
  assert.equal(h.state.player.gold, gold + 35); assert.equal(h.state.online.receiptProgress['l-test'].through, 1);
  const persisted = JSON.parse(h.storage.getItem(h.run('STORAGE_KEY'))); assert.equal(persisted.player.gold, gold + 35);
  assert.equal(ws.sent.filter(p => p.type === 'receipt_ack').length, 2);
});

test('actual client and server complete a v11 duel, persist locally, and acknowledge its durable receipt', async t => {
  const realm = realmHarness(t), client = clientHarness(t), own = await connectClient(realm, client), opponent = await realm.add({ classId: 'arcanist', alias: 'Peer' });
  const { h } = client; assert.equal(h.json('OnlineRealm.getStatus()').status, 'live');
  h.run('OnlineRealm.queue("duel")'); assert.equal(h.run('OnlineRealm.isBusy()'), true); await realm.server.idle();
  await opponent.ws.receive({ type: 'arena_queue', mode: 'duel' });
  const b = realm.server.battles.get(own.session.battleId), before = h.state.player.gold;
  h.document.getElementById('online-battle-target').value = opponent.id;
  for (let step = 0; step < 30 && b.status === 'active'; step++) {
    realm.clock.elapse(1000); const m = b.members.find(m => m.id === own.id);
    h.run(`OnlineRealm.act(${JSON.stringify(m.skillCd ? 'attack' : 'skill')})`); await realm.server.idle();
    if (b.status === 'active') await sendAction(opponent, b, 'guard'); await realm.server.idle();
  }
  assert.equal(b.status, 'finished'); assert.equal(own.remote.last('battle_result').outcome, 'victory'); assert.equal(h.state.player.gold, before + 35);
  const saved = await realm.storage.get(own.session.ownerKey); assert.equal(saved.pending.length, 0); assert.equal(saved.issued, 1);
  own.ws.receive(own.remote.last('battle_result')); await realm.server.idle(); assert.equal(h.state.player.gold, before + 35);
});

test('BroadcastChannel remains same-browser presence/chat without fictional allies or rewards', t => {
  const channels = new Set();
  class LocalChannel {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const peer of channels) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data: structuredClone(data) }); }
    close() { channels.delete(this); }
  }
  const a = clientHarness(t, { globals: { BroadcastChannel: LocalChannel } }).h, b = clientHarness(t, { globals: { BroadcastChannel: LocalChannel } }).h;
  for (const [h, alias] of [[a, 'Alice'], [b, 'Bob']]) {
    h.document.getElementById('input-cf-worker-url').value = ''; h.document.getElementById('input-online-alias').value = alias; h.run('OnlineRealm.connect()');
    assert.equal(h.json('OnlineRealm.getStatus()').status, 'tabs');
  }
  assert.match(a.document.getElementById('online-players-list').innerHTML, /Bob/);
  a.document.getElementById('input-online-chat').value = '<img src=x onerror=bad()>'; a.run('OnlineRealm.chat()');
  assert.match(b.document.getElementById('online-chat-log').innerHTML, /&lt;img/); assert.doesNotMatch(b.document.getElementById('online-chat-log').innerHTML, /<img/);
  const gold = a.state.player.gold; a.run('OnlineRealm.joinRaid(); OnlineRealm.queue("team")'); assert.equal(a.state.player.gold, gold);
  assert.match(a.document.getElementById('online-live-error').textContent, /Worker/);
});
