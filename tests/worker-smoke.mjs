/** Real local workerd check. Start `wrangler dev --local` before running.
 * `--phase seed` writes one unacknowledged result; restart Wrangler with the
 * same --persist-to directory, then use `--phase recover` to verify durability.
 * Only loopback URLs are permitted. All characters and credentials are synthetic.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const base = new URL(option('--url', 'http://127.0.0.1:8787'));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Smoke tests only allow a local Worker URL.');
assert(['http:', 'https:'].includes(base.protocol));
const phase = option('--phase', 'all');
assert(['seed', 'recover', 'all'].includes(phase), 'Use --phase seed, recover, or all.');
const statePath = option('--state', join(tmpdir(), 'aethelgard-worker-smoke.json'));
const sockets = new Set();
const identity = () => ({ heroId: `h-${randomBytes(16).toString('hex')}`, token: randomBytes(32).toString('hex') });
const passport = alias => ({ alias, guild: 'SMOKE', room: 'r_town_square', classId: 'arcanist', level: 5, atk: 20, mag: 30, def: 8, maxHp: 170 });

function client(realm) {
  const url = new URL('/websocket', base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('realm', realm);
  const ws = new WebSocket(url), packets = [], listeners = new Set();
  sockets.add(ws);
  ws.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    packets.push(packet);
    for (const listener of listeners) listener(packet);
  });
  ws.addEventListener('close', () => sockets.delete(ws));
  ws.addEventListener('error', () => {});
  function waitFor(predicate, description) {
    const existing = packets.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(onPacket);
        const errors = packets.filter(p => p.type === 'error').map(p => p.code).join(', ');
        reject(new Error(`Timed out waiting for ${description}; server error codes: ${errors || 'none'}`));
      }, 12000);
      function onPacket(packet) {
        if (!predicate(packet)) return;
        clearTimeout(timer); listeners.delete(onPacket); resolve(packet);
      }
      listeners.add(onPacket);
    });
  }
  return { ws, packets, waitFor, send: packet => ws.send(JSON.stringify(packet)) };
}
async function connect(realm, owner, alias) {
  const c = client(realm);
  const welcome = await c.waitFor(p => p.type === 'welcome', 'welcome');
  assert.equal(welcome.protocol, 11);
  assert(welcome.build?.id, 'The deployed Worker must report its build.');
  c.send({ type: 'hello', protocol: 11, passport: passport(alias), identity: owner });
  c.ready = await c.waitFor(p => p.type === 'ready', 'durable identity handshake');
  assert.equal(c.ready.heroId, owner.heroId);
  assert(c.ready.receipts.ledgerId);
  return c;
}
async function close(c) {
  if (c.ws.readyState === WebSocket.CLOSED) return;
  const ended = new Promise(resolve => c.ws.addEventListener('close', resolve, { once: true }));
  c.ws.close(1000, 'Local smoke test complete');
  await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 1000))]);
}
async function seed() {
  const realm = `smoke-${randomBytes(8).toString('hex')}`, owner = identity();
  const health = await fetch(new URL(`/health?realm=${realm}`, base)).then(r => {
    assert(r.ok, 'Health endpoint should be reachable.'); return r.json();
  });
  assert.equal(health.protocol, 11); assert.equal(health.durableReceipts, true); assert(health.build.id);
  const old = client(realm);
  await old.waitFor(p => p.type === 'welcome', 'legacy welcome');
  old.send({ type: 'hello', protocol: 10, passport: passport('Legacy'), identity: identity() });
  const upgrade = await old.waitFor(p => p.type === 'error', 'upgrade instruction');
  assert.equal(upgrade.code, 'protocol'); assert.match(upgrade.message, /11/);
  await close(old);
  const winner = await connect(realm, owner, 'Smoke winner');
  const loser = await connect(realm, identity(), 'Smoke opponent');
  winner.send({ type: 'arena_queue', mode: 'duel', requestId: 'smoke-winner' });
  loser.send({ type: 'arena_queue', mode: 'duel', requestId: 'smoke-opponent' });
  let packet = await winner.waitFor(p => p.type === 'battle' && p.battle.status === 'active', 'duel start');
  const battleId = packet.battle.id;
  while (packet.battle.status === 'active') {
    const { round, members } = packet.battle;
    assert(round <= 30, 'Duel must finish within the round limit.');
    const self = members.find(m => m.id === winner.ready.sessionId);
    winner.send({ type: 'battle_action', battleId, round, action: self.skillCd ? 'attack' : 'skill', targetId: loser.ready.sessionId });
    loser.send({ type: 'battle_action', battleId, round, action: 'guard' });
    packet = await winner.waitFor(p => p.type === 'battle' && p.battle.id === battleId &&
      (p.battle.round > round || p.battle.status === 'finished'), `duel round ${round}`);
  }
  const receipt = await winner.waitFor(p => p.type === 'battle_result' && p.battleId === battleId, 'persisted victory');
  assert.equal(receipt.outcome, 'victory'); assert.equal(receipt.eligible, true);
  assert.equal(receipt.reward.gold, 35); assert.equal(receipt.reward.xp, 60);
  assert.equal(receipt.heroId, owner.heroId);
  assert(!JSON.stringify(winner.packets).includes(owner.token), 'Recovery token must not be echoed.');
  await writeFile(statePath, JSON.stringify({ origin: base.origin, realm, owner, receipt }), { mode: 0o600 });
  await close(winner); await close(loser);
  console.log(`PASS seed: real Worker handshake, protocol upgrade, ${packet.battle.round}-round victory, durable receipt before delivery (${health.build.id}).`);
  console.log('One synthetic unacknowledged receipt is ready for a local runtime restart.');
}
async function recover() {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.origin, base.origin, 'Recovery must use the same local Worker origin.');
  const c = await connect(saved.realm, saved.owner, 'Smoke restored');
  assert.equal(c.ready.receipts.pending, 1);
  const receipt = await c.waitFor(p => p.type === 'battle_result', 'replayed persisted receipt');
  for (const key of ['rewardId', 'battleId', 'ledgerId', 'sequence', 'heroId']) assert.equal(receipt[key], saved.receipt[key]);
  assert.notEqual(receipt.sessionId, saved.receipt.sessionId, 'Recovery should bind the result to the new session.');
  assert.deepEqual(receipt.reward, saved.receipt.reward);
  const ack = { type: 'receipt_ack', ledgerId: receipt.ledgerId, sequence: receipt.sequence, rewardId: receipt.rewardId };
  c.send(ack);
  const first = await c.waitFor(p => p.type === 'receipt_acked', 'durable acknowledgement');
  assert.equal(first.receipts.pending, 0);
  c.send(ack);
  await c.waitFor(p => p.type === 'receipt_acked' && c.packets.filter(p => p.type === 'receipt_acked').length === 2, 'idempotent duplicate acknowledgement');
  await close(c);
  const afterAck = await connect(saved.realm, saved.owner, 'Smoke acknowledged');
  assert.equal(afterAck.ready.receipts.pending, 0);
  afterAck.send({ type: 'receipt_sync' });
  const status = await afterAck.waitFor(p => p.type === 'receipts_status', 'acknowledged receipt absence');
  assert.equal(status.receipts.pending, 0);
  assert.equal(afterAck.packets.filter(p => p.type === 'battle_result').length, 0);
  await close(afterAck);
  await rm(statePath, { force: true });
  console.log('PASS recover: same receipt and reward after reconnect/restart, new session binding, duplicate ACK safe, no pending reward after ACK.');
}
try {
  if (phase !== 'recover') await seed();
  if (phase !== 'seed') await recover();
} finally {
  for (const ws of sockets) ws.close();
}
