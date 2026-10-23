/** Real recovered client + reconstructed server logic; transport/DOM/time are mocks.
 * These tests do not claim that a public Cloudflare realm has been deployed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AethelgardRealmDO, validatePassport, PROTOCOL, LIMITS, default as worker } from '../cloudflare-worker/worker.js';
import { createHarness } from './harness.mjs';

class ServerSocket {
  constructor() { this.messages = []; this.listeners = new Map(); this.closed = false; }
  accept() { this.accepted = true; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  emit(name, data) { for (const fn of this.listeners.get(name) || []) fn(data); }
  send(raw) { if (this.closed) throw new Error('closed'); const packet = JSON.parse(raw); this.messages.push(packet); this.onPacket?.(packet); }
  receive(packet) { this.emit('message', { data: typeof packet === 'string' ? packet : JSON.stringify(packet) }); }
  close(code = 1000) { if (this.closed) return; this.closed = true; this.closeCode = code; this.emit('close', {}); }
  all(type) { return this.messages.filter(packet => packet.type === type); }
  last(type) { return this.all(type).at(-1); }
}
const passport = (overrides = {}) => ({ alias: 'Explorer', guild: 'RIFT', room: 'r_town_square', classId: 'vanguard', level: 5, atk: 40, mag: 25, def: 12, maxHp: 240, ...overrides });

function realmHarness(t) {
  let now = 1000000, sequence = 0, nextTimer = 0;
  const timers = new Map();
  const server = new AethelgardRealmDO({}, {}, { now: () => now, uuid: () => String(++sequence),
    schedule(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    unschedule: id => timers.delete(id) });
  const clock = {
    elapse(ms) { now += ms; },
    run(ms) {
      const target = now + ms;
      for (let i = 0; i < 1000; i++) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = target;
    }
  };
  const add = (overrides = {}, ready = true) => {
    const ws = new ServerSocket(), id = server.handleWebSocket(ws);
    if (ready) ws.receive({ type: 'hello', protocol: PROTOCOL, passport: passport(overrides) });
    return { ws, id, get session() { return server.byId.get(id); } };
  };
  t.after(() => server.dispose());
  return { server, clock, add };
}
const sendAction = (player, battle, action, targetId) => player.ws.receive({ type: 'battle_action', battleId: battle.id, round: battle.round, action, targetId });

test('v10 handshake is required; passport fields are validated and server identity cannot be supplied', t => {
  const h = realmHarness(t), a = h.add({}, false);
  assert.equal(a.ws.last('welcome').protocol, 10);
  assert.equal(h.server.byId.get(a.id).ready, false);
  a.ws.receive({ type: 'hello', protocol: 9, passport: passport() });
  assert.equal(a.ws.all('ready').length, 0);
  a.ws.receive({ type: 'hello', protocol: 10, passport: passport({ classId: 'admin' }) });
  assert.equal(a.ws.last('error').code, 'passport');
  a.ws.receive({ type: 'hello', protocol: 10, sessionId: 'forged', passport: passport({ atk: 1e9, maxHp: 1e9 }) });
  assert.equal(a.ws.last('ready').sessionId, a.id);
  assert.equal(a.session.passport.atk, 120);
  assert.equal(a.session.passport.maxHp, 800);
  assert.throws(() => validatePassport(passport({ atk: Infinity })), /finite/);
  assert.throws(() => validatePassport(passport({ room: '../private' })), /room/);
});

test('presence and room chat contain actual sessions and use the socket-bound sender', t => {
  const h = realmHarness(t), a = h.add({ alias: 'Alice' }), b = h.add({ alias: 'Bob' }), c = h.add({ alias: 'Carol', room: 'r_tavern' });
  assert.equal(a.ws.last('presence').players.length, 3);
  a.ws.receive({ type: 'chat', text: 'Hello', sessionId: b.id, alias: 'Bob', room: 'r_tavern' });
  assert.equal(b.ws.last('chat').alias, 'Alice');
  assert.equal(b.ws.last('chat').sessionId, a.id);
  assert.equal(c.ws.all('chat').length, 0);
  a.ws.receive({ type: 'chat', text: 'Too fast' });
  assert.equal(a.ws.last('error').code, 'chat_rate');
  b.ws.close();
  assert.equal(a.ws.last('presence').players.length, 2);
  assert.equal(h.server.byId.has(b.id), false);
});

test('raid lobby needs real room companions, leader start and no entry reward', t => {
  const h = realmHarness(t), a = h.add(), b = h.add(), elsewhere = h.add({ room: 'r_tavern' });
  a.ws.receive({ type: 'raid_join' }); a.ws.receive({ type: 'raid_start' });
  assert.equal(a.ws.last('error').code, 'players');
  elsewhere.ws.receive({ type: 'raid_join' });
  assert.notEqual(elsewhere.session.battleId, a.session.battleId);
  b.ws.receive({ type: 'raid_join' }); b.ws.receive({ type: 'raid_start' });
  assert.equal(b.ws.last('error').code, 'leader');
  a.ws.receive({ type: 'raid_start' });
  const battle = h.server.battles.get(a.session.battleId);
  assert.equal(battle.status, 'active'); assert.ok(battle.boss.hp > 0);
  assert.equal(a.ws.all('battle_result').length, 0);
  const before = { ...a.session.passport };
  a.ws.receive({ type: 'sync', passport: passport({ room: 'r_tavern', atk: 120 }) });
  assert.deepEqual(a.session.passport, before);
  assert.equal(a.ws.last('error').code, 'busy');
});

test('actual raid actions defeat the tracked boss and emit each earned reward only once', t => {
  const h = realmHarness(t), players = [h.add({ alias: 'A' }), h.add({ alias: 'B' })];
  players.forEach(p => p.ws.receive({ type: 'raid_join' })); players[0].ws.receive({ type: 'raid_start' });
  const b = h.server.battles.get(players[0].session.battleId), initial = b.boss.hp;
  for (let step = 0; step < 30 && b.status === 'active'; step++) {
    h.clock.elapse(1000);
    for (const p of players) {
      const m = b.members.find(m => m.id === p.id); if (!m || m.hp <= 0 || b.status !== 'active') continue;
      const action = m.hp < m.maxHp * .4 && m.heals ? 'heal' : m.skillCd === 0 ? 'skill' : b.boss.intent === 'focus' && b.boss.targetId === m.id ? 'guard' : 'attack';
      sendAction(p, b, action);
    }
  }
  assert.equal(b.status, 'finished'); assert.equal(b.boss.hp, 0); assert.ok(initial > 0);
  for (const p of players) {
    const reward = p.ws.last('battle_result');
    assert.equal(reward.outcome, 'victory'); assert.equal(reward.eligible, true);
    assert.ok(reward.reward.gold > 0 && reward.reward.loot);
    assert.equal(reward.rewardId, `${b.id}:${p.id}`);
    assert.equal(p.ws.all('battle_result').length, 1);
  }
  h.server.finish(b, 0);
  assert.equal(players[0].ws.all('battle_result').length, 1);
});

test('timeout auto-guard is real, but an idle raid passenger does not earn rewards', t => {
  const h = realmHarness(t), active = h.add({ atk: 120, mag: 120, def: 60, maxHp: 800 }), idle = h.add({ atk: 8, mag: 8, def: 60, maxHp: 800 });
  active.ws.receive({ type: 'raid_join' }); idle.ws.receive({ type: 'raid_join' }); active.ws.receive({ type: 'raid_start' });
  const b = h.server.battles.get(active.session.battleId);
  for (let round = 0; round < 30 && b.status === 'active'; round++) {
    active.ws.receive({ type: 'ping' }); idle.ws.receive({ type: 'ping' });
    const m = b.members.find(m => m.id === active.id);
    sendAction(active, b, m.skillCd ? 'attack' : 'skill');
    h.clock.run(LIMITS.roundMs);
  }
  assert.equal(b.boss.hp, 0);
  assert.ok(b.log.some(entry => entry.en.includes('automatically')));
  assert.equal(b.members.find(m => m.id === idle.id).contribution, 0);
  const result = idle.ws.last('battle_result');
  assert.equal(result.outcome, 'victory'); assert.equal(result.eligible, false);
  assert.deepEqual(result.reward, { gold: 0, xp: 0, shards: 0, glory: 0, loot: false });
});

test('team arena waits for six distinct sessions; queues cannot duplicate a player', t => {
  const h = realmHarness(t), players = Array.from({ length: 6 }, (_, i) => h.add({ alias: `P${i}`, atk: i ? 9 : 1e8, maxHp: i ? 80 : 1e8 }));
  players.slice(0, 5).forEach(p => p.ws.receive({ type: 'arena_queue', mode: 'team' }));
  players[0].ws.receive({ type: 'arena_queue', mode: 'team' });
  assert.equal(h.server.queues.team.length, 5);
  assert.equal(players[0].ws.last('queue').count, 5);
  assert.equal(h.server.battles.size, 0);
  players[5].ws.receive({ type: 'arena_queue', mode: 'team' });
  const b = h.server.battles.get(players[0].session.battleId);
  assert.equal(b.members.length, 6);
  assert.equal(b.members.filter(m => m.team === 0).length, 3);
  assert.equal(new Set(b.members.map(m => m.id)).size, 6);
  assert.equal(b.members[0].maxHp, b.members[1].maxHp);
  assert.equal(b.members[0].atk, b.members[1].atk);
  assert.ok(players.every(p => p.ws.all('battle_result').length === 0));
});

test('arena actions reject spoofed actors, invalid targets, repeated turns and cooldown skills', t => {
  const h = realmHarness(t), a = h.add(), b = h.add();
  a.ws.receive({ type: 'arena_queue', mode: 'duel' }); b.ws.receive({ type: 'arena_queue', mode: 'duel' });
  const battle = h.server.battles.get(a.session.battleId), first = battle.members[0], second = battle.members[1];
  sendAction(a, battle, 'attack', a.id);
  assert.equal(first.action, null); assert.equal(a.ws.last('error').code, 'target');
  a.ws.receive({ type: 'battle_action', battleId: battle.id, round: battle.round, action: 'skill', targetId: b.id, sessionId: b.id });
  assert.equal(first.contribution, 1); assert.equal(second.contribution, 0);
  sendAction(a, battle, 'attack', b.id);
  assert.equal(a.ws.last('error').code, 'already_acted'); assert.equal(first.contribution, 1);
  sendAction(b, battle, 'guard');
  assert.equal(battle.round, 2); assert.ok(second.hp < second.maxHp); assert.equal(first.skillCd, 2);
  sendAction(a, battle, 'skill', b.id);
  assert.equal(a.ws.last('error').code, 'cooldown'); assert.equal(first.contribution, 1);
  a.ws.receive({ type: 'battle_action', battleId: battle.id, round: 1, action: 'attack', targetId: b.id });
  assert.equal(a.ws.last('error').code, 'battle_state');
});

test('forfeit, idle cleanup and queue expiry do not award joining or waiting', t => {
  const h = realmHarness(t), a = h.add(), b = h.add();
  a.ws.receive({ type: 'arena_queue', mode: 'duel' }); b.ws.receive({ type: 'arena_queue', mode: 'duel' });
  b.ws.close();
  assert.equal(a.ws.last('battle_result').outcome, 'victory');
  assert.equal(a.ws.last('battle_result').eligible, false);
  assert.equal(a.ws.last('battle_result').reward.gold, 0);
  a.ws.receive({ type: 'arena_queue', mode: 'team' });
  h.clock.elapse(LIMITS.queueMs + 1); a.ws.receive({ type: 'ping' }); h.server.sweep();
  assert.equal(a.session.queueMode, null); assert.equal(a.ws.last('error').code, 'queue_timeout');
  h.clock.elapse(LIMITS.idleMs + 1); h.server.sweep();
  assert.equal(h.server.sessions.size, 0);
});

test('server rejects oversized/spam frames and validates HTTP realm/origin boundaries', async t => {
  const h = realmHarness(t), a = h.add(), b = h.add();
  a.ws.receive('x'.repeat(LIMITS.packet + 1)); assert.equal(a.ws.closeCode, 1009);
  for (let i = 0; i < 46; i++) b.ws.receive({ type: 'ping' });
  assert.equal(b.ws.closeCode, 1008);
  const env = { ALLOWED_ORIGINS: 'https://game.example', AETHELGARD_REALM: { idFromName: x => x, get: () => h.server } };
  assert.equal((await worker.fetch(new Request('https://realm.example/?realm=bad%2Fname'), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://realm.example/', { method: 'POST' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request('https://realm.example/', { headers: { Upgrade: 'websocket', Origin: 'https://untrusted.example' } }), env)).status, 403);
  const health = await (await worker.fetch(new Request('https://realm.example/health'), env)).json();
  assert.equal(health.protocol, 10); assert.equal(health.onlinePlayers, 0);
});

function clientHarness(t, extra = {}) {
  const sockets = [];
  class MockWebSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); this.onSend?.(raw); }
    receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const h = createHarness({ modules: ['core', 'gameplay', 'combat', 'online'], globals: { WebSocket: MockWebSocket, ...extra } });
  t.after(() => { h.run('OnlineRealm.disconnect(true)'); h.dispose(); });
  h.document.getElementById('input-cf-worker-url').value = 'wss://realm.example/';
  return { h, sockets };
}
const readyClient = (h, socket, id = 'self') => { socket.receive({ type: 'welcome', protocol: 10, sessionId: id }); socket.receive({ type: 'ready', protocol: 10, sessionId: id }); };

test('real client waits for both handshake messages and validates/deduplicates server rewards', t => {
  const { h, sockets } = clientHarness(t);
  h.run('state.online = { partyAllies:[{name:"fake ally"}] }; OnlineRealm.connect()');
  const ws = sockets[0];
  assert.equal(h.json('OnlineRealm.getStatus()').status, 'connecting');
  ws.receive({ type: 'ready', protocol: 10, sessionId: 'self' });
  assert.equal(h.json('OnlineRealm.getStatus()').status, 'connecting');
  readyClient(h, ws);
  assert.equal(h.json('OnlineRealm.getStatus()').status, 'live');
  assert.equal(h.json('state.online.partyAllies').length, 0);
  const baseGold = h.state.player.gold;
  const member = id => ({ id, alias: id, team: id === 'self' ? 0 : 1, hp: 100, maxHp: 100, skillCd: 0, heals: 2 });
  const battle = { id: 'test-battle', kind: 'arena', mode: 'duel', status: 'active', round: 1, members: [member('self'), member('other')], log: [], boss: null };
  const result = { type: 'battle_result', battleId: battle.id, sessionId: 'self', rewardId: `${battle.id}:self`, outcome: 'victory', eligible: true, reward: { gold: 35, xp: 0, shards: 1, glory: 4, loot: false } };
  ws.receive({ type: 'battle', battle }); ws.receive(result);
  assert.equal(h.state.player.gold, baseGold);
  assert.equal(h.run('OnlineRealm.isBusy()'), true);
  const beforeSync = ws.sent.length; h.run('OnlineRealm.sync(true)'); assert.equal(ws.sent.length, beforeSync);
  ws.receive({ type: 'battle', battle: { ...battle, status: 'finished' } });
  ws.receive({ ...result, reward: { ...result.reward, gold: 1001 } });
  ws.receive({ ...result, sessionId: 'other' });
  assert.equal(h.state.player.gold, baseGold); assert.equal(h.state.online.claimedRewards.length, 0);
  ws.receive(result); ws.receive(result);
  assert.equal(h.state.player.gold, baseGold + 35); assert.equal(h.state.online.claimedRewards.length, 1);
  assert.equal(h.run('OnlineRealm.isBusy()'), false);
});

test('real client and server complete an arena battle through the actual v10 wire protocol', t => {
  const serverSide = realmHarness(t), { h, sockets } = clientHarness(t);
  h.run('OnlineRealm.connect()'); const ws = sockets[0], remote = new ServerSocket();
  remote.onPacket = packet => ws.receive(packet); ws.onSend = raw => remote.receive(raw);
  const id = serverSide.server.handleWebSocket(remote), opponent = serverSide.add({ classId: 'arcanist', alias: 'Peer' });
  assert.equal(h.json('OnlineRealm.getStatus()').status, 'live');
  h.run('OnlineRealm.queue("duel")'); assert.equal(h.run('OnlineRealm.isBusy()'), true);
  opponent.ws.receive({ type: 'arena_queue', mode: 'duel' });
  const b = serverSide.server.battles.get(serverSide.server.byId.get(id).battleId), before = h.state.player.gold;
  assert.equal(h.json('OnlineRealm.getStatus()').battleId, b.id);
  h.document.getElementById('online-battle-target').value = opponent.id;
  for (let step = 0; step < 30 && b.status === 'active'; step++) {
    serverSide.clock.elapse(1000);
    const own = b.members.find(m => m.id === id);
    h.run(`OnlineRealm.act(${JSON.stringify(own.skillCd ? 'attack' : 'skill')})`);
    if (b.status === 'active') sendAction(opponent, b, 'guard');
  }
  assert.equal(b.status, 'finished'); assert.equal(remote.last('battle_result').outcome, 'victory');
  assert.equal(h.state.player.gold, before + 35); assert.equal(h.state.online.claimedRewards.length, 1);
  ws.receive(remote.last('battle_result'));
  assert.equal(h.state.player.gold, before + 35);
});

test('BroadcastChannel is honest same-browser presence/chat, with no fabricated allies or raid loot', t => {
  const channels = new Set();
  class LocalChannel {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const peer of channels) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data: structuredClone(data) }); }
    close() { channels.delete(this); }
  }
  const a = clientHarness(t, { BroadcastChannel: LocalChannel }).h, b = clientHarness(t, { BroadcastChannel: LocalChannel }).h;
  for (const [h, alias] of [[a, 'Alice'], [b, 'Bob']]) {
    h.document.getElementById('input-cf-worker-url').value = '';
    h.document.getElementById('input-online-alias').value = alias;
    h.run('OnlineRealm.connect()');
    assert.equal(h.json('OnlineRealm.getStatus()').status, 'tabs');
    assert.equal(h.state.online.transport, 'same-browser-tabs');
  }
  assert.match(a.document.getElementById('online-players-list').innerHTML, /Bob/);
  a.document.getElementById('input-online-chat').value = '<img src=x onerror=bad()>';
  a.run('OnlineRealm.chat()');
  const rendered = b.document.getElementById('online-chat-log').innerHTML;
  assert.match(rendered, /&lt;img/); assert.doesNotMatch(rendered, /<img/);
  const gold = a.state.player.gold; a.run('OnlineRealm.joinRaid(); OnlineRealm.queue("team")');
  assert.equal(a.state.player.gold, gold); assert.equal(a.json('OnlineRealm.getStatus()').battleId, null);
  assert.match(a.document.getElementById('online-live-error').textContent, /Worker/);
});
