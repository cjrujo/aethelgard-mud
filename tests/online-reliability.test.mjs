import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL } from '../cloudflare-worker/worker.js';
import { walk } from './harness-campaign.mjs';
import { MemoryStorage, realmHarness, clientHarness, readyClient, connectClient, identity, passport, sendAction, winDuel, ackPacket } from './online-harness.mjs';

const resultFor = (h, overrides = {}) => ({ type: 'battle_result', battleId: 'b-earned', kind: 'arena', ledgerId: 'l-test', sequence: 1,
  rewardId: 'l-test:1', sessionId: 'self', heroId: h.state.online.heroId, outcome: 'victory', eligible: true,
  reward: { gold: 35, xp: 0, shards: 1, glory: 4, loot: false }, ...overrides });
const mockConnect = (t, options) => {
  const client = clientHarness(t, options); client.h.run('OnlineRealm.connect()'); readyClient(client.h, client.sockets[0]); return { ...client, ws: client.sockets[0] };
};

for (const mode of ['raid', 'duel']) test(`delayed ${mode} acknowledgement locks solo play immediately and stops auto-hunt`, t => {
  const { h, ws } = mockConnect(t); walk(h, 'r_wilds_trail'); h.run('toggleAutoHunt()'); assert.equal(h.state.autoHunt, true);
  const sent = h.run(mode === 'raid' ? 'OnlineRealm.joinRaid()' : 'OnlineRealm.queue("duel")'); assert.equal(sent, true);
  assert.equal(h.run('OnlineRealm.isBusy()'), true); assert.equal(h.state.autoHunt, false);
  assert.equal(h.run('engageMob("briar_wolf")'), false); h.run('runWorldTick()'); assert.equal(h.state.combat.inCombat, false);
  const request = ws.sent.at(-1); assert.ok(request.requestId);
  assert.equal(h.run('OnlineRealm.queue("team")'), false); assert.equal(ws.sent.at(-1), request);
  ws.receive({ type: 'error', code: 'unavailable', requestId: request.requestId, message: 'Please try later.' });
  assert.equal(h.run('OnlineRealm.isBusy()'), false); assert.equal(h.run('engageMob("briar_wolf")'), true);
});

test('a pending request timeout closes its socket and ignores late acknowledgements', t => {
  const { h, ws } = mockConnect(t); h.run('OnlineRealm.queue("duel")');
  const timeout = [...h.timers.values()].find(timer => !timer.repeat && timer.delay === 12000); assert.ok(timeout); timeout.fn();
  assert.equal(ws.readyState, 3); assert.equal(h.run('OnlineRealm.isBusy()'), false); assert.equal(h.json('OnlineRealm.getStatus()').status, 'error');
  ws.receive({ type: 'queue', mode: 'duel', count: 1, need: 2 });
  assert.equal(h.run('OnlineRealm.isBusy()'), false); assert.match(h.document.getElementById('online-live-error').textContent, /timed out/);
});

test('a failed request send and a disconnect both release their pending lock', t => {
  const a = mockConnect(t); a.ws.failSend = true; assert.equal(a.h.run('OnlineRealm.joinRaid()'), false); assert.equal(a.h.run('OnlineRealm.isBusy()'), false);
  const b = mockConnect(t); b.h.run('OnlineRealm.queue("team")'); b.ws.close(1006); assert.equal(b.h.run('OnlineRealm.isBusy()'), false);
  assert.equal(b.h.json('OnlineRealm.getStatus()').pending, null);
});

test('read-only tabs cannot connect, join, send battle actions or collect a receipt', t => {
  const { h, ws } = mockConnect(t), r = resultFor(h), before = h.json('state.player');
  h.run('window.AethelgardApp = {canWrite:()=>false}'); const sent = ws.sent.length;
  assert.equal(h.run('OnlineRealm.queue("duel")'), false); assert.equal(h.run('OnlineRealm.joinRaid()'), false);
  ws.receive(r); assert.deepEqual(h.json('state.player'), before); assert.equal(ws.sent.length, sent);
  h.run('OnlineRealm.disconnect(true); OnlineRealm.connect()'); assert.equal(h.json('OnlineRealm.getStatus()').status, 'offline');
});

test('a failed local save rolls back reward, level-up, generated world and loot without acknowledging', t => {
  const { h, ws } = mockConnect(t);
  h.run("renderAll(); saveGameState(false)");
  const before = h.json('({player:state.player,world:state.world,director:state.director,ledger:state.combatLedger,rooms:WORLD_ROOMS,mobs:MOB_TEMPLATES,items:ITEM_CATALOG})');
  const r = resultFor(h, { kind: 'raid', reward: { gold: 140, xp: 180, shards: 2, glory: 5, loot: true } });
  const raw = h.storage.getItem(h.run('STORAGE_KEY')); h.storage.failWrites = key => key === h.run('STORAGE_KEY'); ws.receive(r);
  assert.deepEqual(h.json('({player:state.player,world:state.world,director:state.director,ledger:state.combatLedger,rooms:WORLD_ROOMS,mobs:MOB_TEMPLATES,items:ITEM_CATALOG})'), before);
  assert.equal(h.storage.getItem(h.run('STORAGE_KEY')), raw); assert.equal(ws.sent.filter(p => p.type === 'receipt_ack').length, 0);
  assert.match(h.document.getElementById('online-reward-status').textContent, /local saving failed/);
  h.storage.failWrites = false; ws.receive(r); assert.ok(h.state.player.level > before.player.level);
  assert.equal(h.state.player.gold, before.player.gold + 140); assert.equal(ws.sent.filter(p => p.type === 'receipt_ack').length, 1);
  ws.receive(r); assert.equal(h.state.player.gold, before.player.gold + 140);
});

test('new heroes receive a separate recovery token and late packets cannot reward the replacement hero', t => {
  const { h, ws } = mockConnect(t), oldHero = h.state.online.heroId, oldToken = Object.values(h.state.online.recoveryTokens)[0], oldPacket = resultFor(h);
  h.run('resetNewGame()'); const gold = h.state.player.gold;
  ws.receive(oldPacket); assert.equal(h.state.player.gold, gold);
  h.document.getElementById('input-cf-worker-url').value = 'wss://realm.example/'; h.run('OnlineRealm.connect()');
  assert.notEqual(h.state.online.heroId, oldHero); assert.notEqual(Object.values(h.state.online.recoveryTokens)[0], oldToken);
});

test('recovery identity follows its JSON hero but is isolated between realm endpoints', t => {
  const { h, ws } = mockConnect(t), before = h.json('state.online');
  h.run('OnlineRealm.disconnect(true)'); h.document.getElementById('input-cf-worker-url').value = 'wss://realm.example/websocket?realm=friends'; h.run('OnlineRealm.connect()');
  const current = h.json('state.online'); assert.equal(current.heroId, before.heroId);
  const keys = Object.keys(current.recoveryTokens); assert.equal(keys.length, 2); assert.equal(new Set(Object.values(current.recoveryTokens)).size, 2);
  const saved = h.json('state'); h.run('OnlineRealm.disconnect(true); resetNewGame()');
  h.run(`AethelgardApp.restore(${JSON.stringify(saved)})`); assert.equal(h.state.online.heroId, before.heroId);
  assert.deepEqual(h.json('state.online.recoveryTokens'), current.recoveryTokens);
});

test('a dropped final result is durable before send and survives a new Durable Object instance', async t => {
  const realm = realmHarness(t), a = await realm.add(), b = await realm.add(); const owner = a.session.ownerKey;
  let persistedWhenSending = false;
  a.ws.drop = packet => { if (packet.type !== 'battle_result') return false; persistedWhenSending = realm.storage.data.get(owner).pending.some(r => r.rewardId === packet.rewardId); return true; };
  const battle = await winDuel(realm, a, b); assert.equal(battle.status, 'finished'); assert.equal(a.ws.last('battle').battle.status, 'finished');
  assert.equal(persistedWhenSending, true); assert.equal(a.ws.all('battle_result').length, 0);
  realm.server.dispose(); const restarted = realmHarness(t, { storage: realm.storage });
  const recovered = await restarted.add({}, true, a.identity), r = recovered.ws.last('battle_result');
  assert.notEqual(recovered.id, a.id); assert.equal(r.sessionId, recovered.id); assert.equal(r.heroId, a.identity.heroId); assert.equal(r.outcome, 'victory'); assert.equal(r.reward.gold, 35);
  await recovered.ws.receive(ackPacket(r)); assert.equal((await restarted.storage.get(recovered.session.ownerKey)).pending.length, 0);
});

test('missing or forged tokens cannot fetch or acknowledge another hero\'s reward', async t => {
  const realm = realmHarness(t), a = await realm.add(), b = await realm.add(); await winDuel(realm, a, b);
  const r = a.ws.last('battle_result'), impostor = await realm.add();
  await impostor.ws.receive(ackPacket(r)); assert.equal(impostor.ws.last('error').code, 'receipt_owner');
  assert.equal((await realm.storage.get(a.session.ownerKey)).pending.length, 1);
  const wrongHero = await realm.add({}, false);
  await wrongHero.ws.receive({ type: 'hello', protocol: PROTOCOL, passport: passport(), identity: { ...a.identity, heroId: identity().heroId } });
  assert.equal(wrongHero.ws.last('error').code, 'identity_mismatch'); assert.equal(wrongHero.ws.all('battle_result').length, 0);
  const wrongToken = await realm.add({}, true, { ...a.identity, token: identity().token }); assert.equal(wrongToken.ws.all('battle_result').length, 0);
});

test('a lost acknowledgement replays after reconnect/reload without granting a second reward', async t => {
  const realm = realmHarness(t), shared = new Map(), client = clientHarness(t, { storage: shared });
  const own = await connectClient(realm, client), opponent = await realm.add({ classId: 'arcanist' });
  own.ws.drop = packet => packet.type === 'receipt_ack';
  client.h.run('OnlineRealm.queue("duel")'); await realm.server.idle(); await opponent.ws.receive({ type: 'arena_queue', mode: 'duel' });
  const b = realm.server.battles.get(own.session.battleId), gold = client.h.state.player.gold, owner = own.session.ownerKey;
  client.h.document.getElementById('online-battle-target').value = opponent.id;
  for (let step = 0; step < 30 && b.status === 'active'; step++) {
    realm.clock.elapse(1000); const m = b.members.find(m => m.id === own.id);
    client.h.run(`OnlineRealm.act(${JSON.stringify(m.skillCd ? 'attack' : 'skill')})`); await realm.server.idle();
    if (b.status === 'active') await sendAction(opponent, b, 'guard'); await realm.server.idle();
  }
  assert.equal(client.h.state.player.gold, gold + 35); assert.equal((await realm.storage.get(owner)).pending.length, 1);
  client.h.run('window.dispatchEvent({type:"pagehide"})'); await realm.server.idle();
  const reloaded = clientHarness(t, { storage: shared }); assert.equal(reloaded.h.run('loadGameState(false)'), true);
  const resumed = await connectClient(realm, reloaded);
  assert.ok(resumed.remote.last('battle_result')); assert.equal(reloaded.h.state.player.gold, gold + 35);
  assert.equal((await realm.storage.get(owner)).pending.length, 0);
  assert.equal(JSON.parse(shared.get(reloaded.h.run('STORAGE_KEY'))).player.gold, gold + 35);
});

test('receipt transaction failure keeps the battle settling and awards nothing until retry succeeds', async t => {
  const realm = realmHarness(t), a = await realm.add(), b = await realm.add();
  realm.storage.failWrites = (_key, value) => value.pending?.length > 0;
  const battle = await winDuel(realm, a, b); assert.equal(battle.status, 'settling'); assert.equal(a.ws.all('battle_result').length, 0);
  assert.equal((await realm.storage.get(a.session.ownerKey)).pending.length, 0);
  assert.equal((await realm.storage.get(b.session.ownerKey)).pending.length, 0);
  realm.storage.failWrites = false; await realm.clock.run(5000);
  assert.equal(battle.status, 'finished'); assert.equal(a.ws.last('battle_result').outcome, 'victory'); assert.equal(a.ws.all('battle_result').length, 1);
});

test('unavailable persistent storage refuses readiness instead of claiming reliable rewards', async t => {
  const storage = new MemoryStorage(); storage.failWrites = true;
  const realm = realmHarness(t, { storage }), a = await realm.add();
  assert.equal(a.ws.all('ready').length, 0); assert.equal(a.ws.last('error').code, 'storage_unavailable'); assert.equal(a.session.ready, false);
});

test('diagnostics show both builds and last communication without any recovery credential', async t => {
  const { h, ws } = mockConnect(t, { globals: { AETHELGARD_BUILD: { version: '11.0.0', id: 'client-test', protocol: 11 } } });
  const report = h.json('OnlineRealm.diagnostics()'), token = Object.values(h.state.online.recoveryTokens)[0];
  assert.equal(report.client.id, 'client-test'); assert.equal(report.server.id, 'test-server'); assert.equal(report.serverProtocol, 11); assert.ok(report.lastCommunication);
  assert.ok(!JSON.stringify(report).includes(token));
  const copied = await h.run('OnlineRealm.copyDiagnostics()'); assert.equal(copied, JSON.stringify(report, null, 2));
  assert.equal(h.document.getElementById('online-diagnostics-copy').hidden, false);
  h.run('OnlineRealm.disconnect(true); OnlineRealm.connect()');
});

test('client explains an old server protocol without entering a live session', t => {
  const { h, sockets } = clientHarness(t); h.run('OnlineRealm.connect()'); sockets[0].receive({ type: 'welcome', protocol: 10, sessionId: 'old-server' });
  assert.equal(h.json('OnlineRealm.getStatus()').status, 'error'); assert.equal(sockets[0].readyState, 3);
  assert.match(h.document.getElementById('online-live-error').textContent, /protocol 11.*protocol 10/);
});

test('an unrelated receipt error cannot unlock an in-flight join, and leave waits for acknowledgement', t => {
  const { h, ws } = mockConnect(t); h.run('OnlineRealm.queue("duel")');
  ws.receive({ type: 'error', code: 'storage_unavailable', requestId: null, message: 'Receipt storage is temporarily unavailable.' });
  assert.equal(h.run('OnlineRealm.isBusy()'), true);
  ws.receive({ type: 'queue', mode: 'duel', count: 1, need: 2 }); assert.equal(h.json('OnlineRealm.getStatus()').pending, null);
  h.run('OnlineRealm.leaveQueue()'); assert.equal(h.json('OnlineRealm.getStatus()').pending, 'leaving'); assert.equal(h.run('OnlineRealm.isBusy()'), true);
  ws.receive({ type: 'queue', mode: 'duel', count: 1, need: 2 }); assert.equal(h.json('OnlineRealm.getStatus()').pending, 'leaving');
  ws.receive({ type: 'queue_left' }); assert.equal(h.run('OnlineRealm.isBusy()'), false);
});

test('out-of-order receipts and repeats cannot skip an older unclaimed reward', t => {
  const { h, ws } = mockConnect(t), gold = h.state.player.gold;
  const first = resultFor(h), second = resultFor(h, { sequence: 2, rewardId: 'l-test:2', battleId: 'b-later' });
  ws.receive(second); ws.receive(second); assert.equal(h.state.player.gold, gold + 35);
  assert.equal(h.state.online.receiptProgress['l-test'].through, 0);
  ws.receive(first); assert.equal(h.state.player.gold, gold + 70);
  assert.equal(h.state.online.receiptProgress['l-test'].through, 2);
  ws.receive(first); ws.receive(second); assert.equal(h.state.player.gold, gold + 70);
});

test('v10 online settings and old reward ids migrate without copying a fabricated identity', t => {
  const { h, sockets } = clientHarness(t);
  h.run('state.online={alias:"Veteran",guildTag:"OLD",workerUrl:"wss://realm.example/",gloryPoints:42,claimedRewards:["v10-battle:old-session"],partyAllies:[{name:"fake"}]}; OnlineRealm.connect()');
  assert.equal(sockets.length, 1); assert.equal(h.state.online.gloryPoints, 42);
  assert.deepEqual(h.json('state.online.claimedRewards'), ['v10-battle:old-session']); assert.equal(h.state.online.partyAllies.length, 0);
  assert.match(h.state.online.heroId, /^h-[a-f0-9]{32}$/);
  const persisted = JSON.parse(h.storage.getItem(h.run('STORAGE_KEY')));
  assert.equal(persisted.online.heroId, h.state.online.heroId);
  assert.deepEqual(persisted.online.recoveryTokens, h.json('state.online.recoveryTokens'));
  const blocked = clientHarness(t); blocked.h.storage.failWrites = true; blocked.h.run('OnlineRealm.connect()'); assert.equal(blocked.sockets.length, 0);
});

// Fixture seeds legitimate durable outcomes directly, so this test focuses on
// recovery batching/acknowledgement, without repeating hundreds of combat rounds.
async function seedReceipts(realm, session, count) {
  for (let n = 1; n <= count; n++) await realm.server.receipts.settle([{ ownerKey: session.ownerKey, heroId: session.heroId,
    battleId: `b-backlog-${n}`, kind: 'arena', mode: 'duel', outcome: 'victory', eligible: true,
    reward: { gold: 35, xp: 0, shards: 1, glory: 4, loot: false }, createdAt: 1000000 + n }]);
}

test('a backlog larger than one recovery batch is collected without hitting the action rate limit', async t => {
  const realm = realmHarness(t), client = clientHarness(t), own = await connectClient(realm, client), owner = own.session.ownerKey;
  const gold = client.h.state.player.gold; await seedReceipts(realm, own.session, 20);
  client.h.run('OnlineRealm.disconnect(true)'); await realm.server.idle();
  const reconnect = await connectClient(realm, client);
  assert.equal(client.h.state.player.gold, gold + 16 * 35); assert.equal((await realm.storage.get(owner)).pending.length, 4);
  realm.clock.elapse(6000); client.h.run('OnlineRealm.retryRewards()'); await realm.server.idle();
  assert.equal(client.h.state.player.gold, gold + 20 * 35); assert.equal((await realm.storage.get(owner)).pending.length, 0);
  assert.equal(reconnect.remote.closed, false); assert.equal(client.h.json('OnlineRealm.getStatus()').status, 'live');
});

test('server acknowledgement storage failure preserves the receipt and retry does not pay twice', async t => {
  const realm = realmHarness(t), client = clientHarness(t), own = await connectClient(realm, client), owner = own.session.ownerKey;
  const gold = client.h.state.player.gold; await seedReceipts(realm, own.session, 1);
  realm.storage.failWrites = (_key, value) => value.issued > 0 && value.pending.length === 0;
  client.h.run('OnlineRealm.retryRewards()'); await realm.server.idle();
  assert.equal(client.h.state.player.gold, gold + 35); assert.equal((await realm.storage.get(owner)).pending.length, 1);
  assert.equal(own.remote.last('error').code, 'storage_unavailable');
  realm.storage.failWrites = false; realm.clock.elapse(6000); client.h.run('OnlineRealm.retryRewards()'); await realm.server.idle();
  assert.equal(client.h.state.player.gold, gold + 35); assert.equal((await realm.storage.get(owner)).pending.length, 0);
});
