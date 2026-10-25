/** Real v11 client/server logic. DOM, sockets, clock and Durable Object storage are
 * controlled doubles; no public server or user's browser storage is contacted. */
import { randomBytes } from 'node:crypto';
import { AethelgardRealmDO, PROTOCOL } from '../cloudflare-worker/worker.js';
import { createHarness } from './harness.mjs';
const clone = value => value === undefined ? undefined : structuredClone(value);

export class MemoryStorage {
  constructor(data = new Map()) { this.data = data; this.failWrites = false; this.writes = []; }
  async get(key) { return clone(this.data.get(key)); }
  async put(key, value) {
    if (this.failWrites === true || (typeof this.failWrites === 'function' && this.failWrites(key, value))) throw new Error('Simulated durable storage failure');
    this.data.set(key, clone(value)); this.writes.push({ key, value: clone(value) });
  }
  async transaction(fn) {
    const pending = new MemoryStorage(new Map([...this.data].map(([key, value]) => [key, clone(value)])));
    pending.failWrites = this.failWrites;
    const result = await fn(pending);
    this.data.clear(); for (const [key, value] of pending.data) this.data.set(key, value);
    this.writes.push(...pending.writes); return result;
  }
}
export class ServerSocket {
  constructor() { this.messages = []; this.listeners = new Map(); this.closed = false; this.drop = null; }
  accept() { this.accepted = true; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  emit(name, data) { return Promise.all((this.listeners.get(name) || []).map(fn => fn(data))); }
  send(raw) {
    if (this.closed) throw new Error('closed'); const packet = JSON.parse(raw);
    if (this.drop?.(packet)) throw new Error('simulated delivery failure');
    this.messages.push(packet); this.onPacket?.(packet);
  }
  receive(packet) { return this.emit('message', { data: typeof packet === 'string' ? packet : JSON.stringify(packet) }); }
  close(code = 1000) { if (this.closed) return Promise.resolve(); this.closed = true; this.closeCode = code; this.onClose?.(code); return this.emit('close', {}); }
  all(type) { return this.messages.filter(packet => packet.type === type); }
  last(type) { return this.all(type).at(-1); }
}
export const identity = () => ({ heroId: 'h-' + randomBytes(16).toString('hex'), token: randomBytes(32).toString('hex') });
export const passport = (overrides = {}) => ({ alias: 'Explorer', guild: 'RIFT', room: 'r_town_square', classId: 'vanguard', level: 5, atk: 40, mag: 25, def: 12, maxHp: 240, ...overrides });

export function realmHarness(t, options = {}) {
  let now = options.now || 1000000, sequence = 0, nextTimer = 0;
  const timers = new Map(), storage = options.storage || new MemoryStorage(), prefix = randomBytes(4).toString('hex');
  const server = new AethelgardRealmDO({ storage }, {}, { now: () => now, uuid: () => `${prefix}-${++sequence}`,
    schedule(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    unschedule: id => timers.delete(id) });
  const clock = {
    elapse(ms) { now += ms; },
    async run(ms) {
      const target = now + ms;
      for (let i = 0; i < 1000; i++) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; await next[1].fn(); await server.idle();
      }
      now = target;
    }
  };
  const add = async (overrides = {}, ready = true, owner = identity()) => {
    const ws = new ServerSocket(), id = server.handleWebSocket(ws);
    if (ready) await ws.receive({ type: 'hello', protocol: PROTOCOL, passport: passport(overrides), identity: owner });
    await server.idle();
    return { ws, id, identity: owner, get session() { return server.byId.get(id); } };
  };
  t?.after(() => server.dispose());
  return { server, clock, add, storage, timers };
}
export const sendAction = (player, battle, action, targetId) => player.ws.receive({ type: 'battle_action', battleId: battle.id, round: battle.round, action, targetId });

export function clientHarness(t, options = {}) {
  const sockets = [];
  class MockWebSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(raw) {
      const packet = JSON.parse(raw); if (this.failSend) throw new Error('send failure');
      this.sent.push(packet); if (!this.drop?.(packet)) this.onSend?.(raw);
    }
    receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); this.onClientClose?.(code); }
  }
  const h = createHarness({ modules: ['core', 'gameplay', 'combat', 'auto-gather', 'map-controls', 'online', 'bootstrap'], storage: options.storage,
    globals: { WebSocket: MockWebSocket, ...(options.globals || {}) } });
  t?.after(() => { h.run('OnlineRealm.disconnect(true)'); h.dispose(); });
  h.document.getElementById('input-cf-worker-url').value = 'wss://realm.example/';
  return { h, sockets };
}
export function readyClient(h, ws, id = 'self', ledgerId = 'l-test') {
  ws.receive({ type: 'welcome', protocol: PROTOCOL, build: { version: '11.0.0', id: 'test-server' }, sessionId: id });
  const owner = h.state.online.heroId;
  ws.receive({ type: 'ready', protocol: PROTOCOL, sessionId: id, heroId: owner, receipts: { ledgerId, floor: 0, pending: 0 } });
}
export async function connectClient(realm, client) {
  client.h.run('OnlineRealm.connect()'); const ws = client.sockets.at(-1), remote = new ServerSocket();
  remote.onPacket = packet => ws.receive(packet);
  remote.onClose = code => { if (ws.readyState !== 3) { ws.readyState = 3; ws.onclose?.({ code }); } };
  ws.onSend = raw => remote.receive(raw); ws.onClientClose = code => remote.close(code);
  const id = realm.server.handleWebSocket(remote); await realm.server.idle();
  return { ws, remote, id, get session() { return realm.server.byId.get(id); } };
}
export async function winDuel(realm, winner, loser) {
  await winner.ws.receive({ type: 'arena_queue', mode: 'duel' }); await loser.ws.receive({ type: 'arena_queue', mode: 'duel' });
  const b = realm.server.battles.get(winner.session.battleId);
  for (let step = 0; step < 30 && b.status === 'active'; step++) {
    realm.clock.elapse(1000);
    const own = b.members.find(m => m.id === winner.id);
    await sendAction(winner, b, own.skillCd ? 'attack' : 'skill', loser.id);
    if (b.status === 'active') await sendAction(loser, b, 'guard');
  }
  await realm.server.idle(); return b;
}
export const ackPacket = r => ({ type: 'receipt_ack', ledgerId: r.ledgerId, sequence: r.sequence, rewardId: r.rewardId });
