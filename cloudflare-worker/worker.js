/** v10 realm protocol. Reconstructed against the recovered real client.
 * Battle state is authoritative within one live Durable Object. There is no
 * account authentication, persistent ranking, or claim of offline-save anti-cheat.
 * Native WebSocket accept() keeps this object active; battles end on a restart.
 */
export const PROTOCOL = 10;
export const LIMITS = Object.freeze({ sessions: 100, packet: 8192, roundMs: 20000,
  idleMs: 90000, handshakeMs: 15000, lobbyMs: 120000, queueMs: 180000, rounds: 30 });
const CLASSES = new Set(["vanguard", "arcanist", "shadowblade"]);
const ARENA = Object.freeze({
  vanguard: { maxHp: 220, atk: 25, mag: 12, def: 14 },
  arcanist: { maxHp: 170, atk: 17, mag: 31, def: 8 },
  shadowblade: { maxHp: 185, atk: 29, mag: 14, def: 10 }
});
const zeroReward = () => ({ gold: 0, xp: 0, shards: 0, glory: 0, loot: false });
const boundedText = (value, length) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, length) : "";
const clampStat = (value, minimum, maximum) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Character stats must be finite numbers.");
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

export function validatePassport(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("A character passport is required.");
  const alias = boundedText(value.alias, 20), guild = boundedText(value.guild, 8).toUpperCase();
  if (!alias || !guild || typeof value.room !== "string" || !/^[A-Za-z0-9_-]{1,90}$/.test(value.room)) throw new Error("Invalid alias, team tag or room.");
  if (!CLASSES.has(value.classId)) throw new Error("Unknown character class.");
  return { alias, guild, room: value.room, classId: value.classId,
    level: clampStat(value.level, 1, 30), atk: clampStat(value.atk, 8, 120),
    mag: clampStat(value.mag, 8, 120), def: clampStat(value.def, 0, 60),
    maxHp: clampStat(value.maxHp, 80, 800) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!["/", "/websocket", "/health"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    if (request.method !== "GET") return new Response("Use GET", { status: 405, headers: { Allow: "GET" } });
    const origins = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (origins.length && !origins.includes(request.headers.get("Origin")) && request.headers.get("Upgrade")?.toLowerCase() === "websocket") return new Response("Origin not allowed", { status: 403 });
    const realm = url.searchParams.get("realm") || "global-shard-1";
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(realm)) return new Response("Invalid realm name", { status: 400 });
    const id = env.AETHELGARD_REALM.idFromName(realm);
    return env.AETHELGARD_REALM.get(id).fetch(request);
  }
};

export class AethelgardRealmDO {
  constructor(state, env, options = {}) {
    this.state = state; this.env = env;
    this.sessions = new Map(); this.byId = new Map(); this.battles = new Map();
    this.queues = { duel: [], team: [] }; this.timers = new Set(); this.sweepTimer = null;
    this.now = options.now || (() => Date.now());
    this.uuid = options.uuid || (() => crypto.randomUUID());
    this.schedule = options.schedule || ((fn, delay) => setTimeout(fn, delay));
    this.unschedule = options.unschedule || (id => clearTimeout(id));
    this.disposed = false;
  }

  async fetch(request) {
    if (request.method !== "GET") return new Response("Use GET", { status: 405 });
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (this.sessions.size >= LIMITS.sessions) return new Response("Realm is full", { status: 503 });
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(JSON.stringify({ service: "Aethelgard live realm", protocol: PROTOCOL,
      onlinePlayers: [...this.sessions.values()].filter(s => s.ready).length,
      activeBattles: [...this.battles.values()].filter(b => b.status === "active").length,
      queued: { duel: this.queues.duel.length, team: this.queues.team.length } }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  later(fn, delay) {
    if (this.disposed) return null;
    const id = this.schedule(() => { this.timers.delete(id); fn(); }, delay);
    this.timers.add(id); return id;
  }
  cancelTimer(id) { if (id != null) { this.unschedule(id); this.timers.delete(id); } }
  startSweep() {
    if (this.sweepTimer != null || !this.sessions.size || this.disposed) return;
    this.sweepTimer = this.later(() => { this.sweepTimer = null; this.sweep(); this.startSweep(); }, 10000);
  }

  handleWebSocket(ws) {
    if (this.disposed || this.sessions.size >= LIMITS.sessions) { try { ws.close(1013, "Realm is full"); } catch {} return null; }
    ws.accept();
    const session = { id: `s-${this.uuid()}`, ws, ready: false, passport: null, battleId: null,
      queueMode: null, queueSince: 0, joinedAt: this.now(), lastSeen: this.now(),
      rateSince: this.now(), rateCount: 0, lastChat: -Infinity };
    this.sessions.set(ws, session); this.byId.set(session.id, session);
    ws.addEventListener("message", event => this.handleMessage(ws, event.data));
    ws.addEventListener("close", () => this.disconnect(ws));
    ws.addEventListener("error", () => this.disconnect(ws));
    this.send(session, { type: "welcome", protocol: PROTOCOL, sessionId: session.id });
    this.startSweep(); return session.id;
  }

  send(session, packet) {
    if (!session || this.sessions.get(session.ws) !== session) return false;
    try { session.ws.send(JSON.stringify({ ...packet, serverTime: this.now() })); return true; }
    catch { this.disconnect(session.ws); return false; }
  }
  error(session, code, message, messageZh = "请求被拒绝，请检查状态后重试。") {
    this.send(session, { type: "error", code, message, messageZh }); return false;
  }
  busy(session) { return Boolean(session.queueMode || session.battleId); }

  handleMessage(ws, raw) {
    const session = this.sessions.get(ws); if (!session) return;
    if (typeof raw !== "string" || raw.length > LIMITS.packet) { this.disconnect(ws, 1009, "Invalid packet size or type"); return; }
    if (this.now() - session.rateSince >= 10000) { session.rateSince = this.now(); session.rateCount = 0; }
    if (++session.rateCount > 45) { this.error(session, "rate_limit", "Too many requests.", "请求过于频繁。"); this.disconnect(ws, 1008, "Rate limit"); return; }
    let packet;
    try { packet = JSON.parse(raw); } catch { this.error(session, "invalid_json", "Expected JSON.", "请发送有效 JSON。"); return; }
    if (!packet || Array.isArray(packet) || typeof packet.type !== "string") { this.error(session, "invalid_packet", "Expected a typed message."); return; }
    session.lastSeen = this.now();
    if (!session.ready) {
      if (packet.type !== "hello" || packet.protocol !== PROTOCOL) {
        this.error(session, "protocol", "A v10 hello is required.", "需要先完成 v10 握手。"); return;
      }
      try { session.passport = validatePassport(packet.passport); }
      catch (error) { this.error(session, "passport", error.message, "角色快照不合法。"); return; }
      session.ready = true;
      this.send(session, { type: "ready", protocol: PROTOCOL, sessionId: session.id });
      this.broadcastPresence(); return;
    }
    switch (packet.type) {
      case "ping": this.send(session, { type: "pong" }); break;
      case "sync":
        if (this.busy(session)) { this.error(session, "busy", "Leave the queue or battle before syncing.", "请退出匹配或结束战斗后同步角色。"); break; }
        try { session.passport = validatePassport(packet.passport); }
        catch (error) { this.error(session, "passport", error.message, "角色快照不合法。"); break; }
        this.send(session, { type: "synced" }); this.broadcastPresence(); break;
      case "chat": this.chat(session, packet.text); break;
      case "raid_join": this.joinRaid(session); break;
      case "raid_start": this.startRaid(session); break;
      case "arena_queue": this.joinQueue(session, packet.mode); break;
      case "queue_leave": this.leaveQueue(session); break;
      case "battle_leave": this.leaveBattle(session); break;
      case "battle_action": this.action(session, packet); break;
      default: this.error(session, "unknown_message", "Unknown v10 message type.", "未知的 v10 消息类型。");
    }
  }

  broadcastPresence() {
    const ready = [...this.sessions.values()].filter(s => s.ready);
    const players = ready.map(s => ({ id: s.id, alias: s.passport.alias, guild: s.passport.guild,
      room: s.passport.room, level: s.passport.level,
      activity: s.queueMode ? "queue" : s.battleId ? "battle" : "exploring" }));
    for (const s of ready) this.send(s, { type: "presence", players });
  }
  chat(session, value) {
    if (typeof value !== "string" || value.length > 240 || !boundedText(value, 240)) return this.error(session, "chat", "Use 1–240 text characters.", "聊天内容需要 1–240 个字符。");
    if (this.now() - session.lastChat < 800) return this.error(session, "chat_rate", "Wait before sending another message.", "请稍候再发送下一条消息。");
    session.lastChat = this.now();
    const packet = { type: "chat", sessionId: session.id, ...session.passport, text: boundedText(value, 240) };
    for (const s of [...this.sessions.values()]) if (s.ready && s.passport.room === session.passport.room) this.send(s, packet);
  }

  makeMember(session, kind, team = 0) {
    const p = session.passport, stats = kind === "arena" ? ARENA[p.classId] : p;
    return { id: session.id, alias: p.alias, classId: p.classId, level: p.level, team,
      maxHp: stats.maxHp, hp: stats.maxHp, atk: stats.atk, mag: stats.mag, def: stats.def,
      skillCd: 0, heals: 2, contribution: 0, damage: 0, disconnected: false, action: null, guarding: false };
  }
  makeBattle(kind, mode, room) {
    const battle = { id: `b-${this.uuid()}`, kind, mode, room, status: kind === "raid" ? "lobby" : "active",
      round: 1, members: [], leader: null, boss: null, log: [], deadline: null, timer: null,
      createdAt: this.now(), resultsSent: false };
    this.battles.set(battle.id, battle); return battle;
  }
  log(battle, en, zh) { battle.log.push({ en: en.slice(0, 500), zh: zh.slice(0, 500) }); battle.log = battle.log.slice(-24); }
  snapshot(battle) {
    return { id: battle.id, kind: battle.kind, mode: battle.mode, status: battle.status,
      round: battle.round, leader: battle.leader, deadline: battle.deadline,
      boss: battle.boss ? { ...battle.boss } : null, log: battle.log.map(entry => ({ ...entry })),
      members: battle.members.map(m => ({ id: m.id, alias: m.alias, classId: m.classId, team: m.team,
        hp: m.hp, maxHp: m.maxHp, skillCd: m.skillCd, heals: m.heals, acted: Boolean(m.action),
        disconnected: m.disconnected, contribution: m.contribution, damage: m.damage })) };
  }
  publishBattle(battle) {
    const snapshot = this.snapshot(battle);
    for (const m of battle.members) {
      const s = this.byId.get(m.id);
      if (s?.battleId === battle.id) this.send(s, { type: "battle", battle: snapshot });
    }
  }

  joinRaid(session) {
    if (this.busy(session)) return this.error(session, "busy", "Already queued or in a battle.", "你已处于匹配或战斗中。");
    let battle = [...this.battles.values()].find(b => b.kind === "raid" && b.status === "lobby" && b.room === session.passport.room && b.members.length < 4);
    if (!battle) { battle = this.makeBattle("raid", "coop", session.passport.room); battle.leader = session.id; }
    battle.members.push(this.makeMember(session, "raid")); session.battleId = battle.id;
    this.log(battle, `${session.passport.alias} joined the expedition lobby.`, `${session.passport.alias} 加入了副本队伍。`);
    this.publishBattle(battle); this.broadcastPresence();
  }
  startRaid(session) {
    const b = this.battles.get(session.battleId);
    if (!b || b.kind !== "raid" || b.status !== "lobby" || b.leader !== session.id) return this.error(session, "leader", "Only the lobby leader can start.", "只有队长能开启副本。");
    if (b.members.length < 2 || b.members.length > 4) return this.error(session, "players", "A raid needs 2–4 connected players.", "协作副本需要 2–4 位已连接玩家。");
    const maxHp = 180 + b.members.length * 80 + b.members.reduce((sum, m) => sum + Math.max(m.atk, m.mag) * 2, 0);
    b.boss = { name: "Riftwarden", nameZh: "裂隙守卫", hp: maxHp, maxHp, intent: "focus", phase: 1,
      def: Math.min(18, 4 + Math.round(b.members.reduce((sum, m) => sum + m.level, 0) / b.members.length)),
      atk: Math.round(b.members.reduce((sum, m) => sum + m.maxHp * .13 + m.def * .25, 0) / b.members.length), targetId: b.members[0].id };
    b.status = "active";
    this.log(b, "The Riftwarden stirs. Read its intent before choosing your action.", "裂隙守卫苏醒了。先观察意图，再选择行动。");
    this.beginRound(b); this.broadcastPresence();
  }

  publishQueues(mode) {
    const need = mode === "team" ? 6 : 2, ids = this.queues[mode];
    for (const id of ids) this.send(this.byId.get(id), { type: "queue", mode, count: ids.length, need });
  }
  joinQueue(session, mode) {
    if (!["duel", "team"].includes(mode)) return this.error(session, "mode", "Choose duel or team arena.", "请选择双人决斗或队伍竞技。");
    if (session.queueMode === mode) { this.publishQueues(mode); return; }
    if (this.busy(session)) return this.error(session, "busy", "Already queued or in a battle.", "你已处于匹配或战斗中。");
    session.queueMode = mode; session.queueSince = this.now(); this.queues[mode].push(session.id);
    this.publishQueues(mode);
    const need = mode === "team" ? 6 : 2;
    if (this.queues[mode].length >= need) {
      const players = this.queues[mode].splice(0, need).map(id => this.byId.get(id));
      const b = this.makeBattle("arena", mode, session.passport.room); b.leader = players[0].id;
      players.forEach((s, i) => { s.queueMode = null; s.battleId = b.id; b.members.push(this.makeMember(s, "arena", i % 2)); });
      this.log(b, "Arena stats are equalized by class. One action per round.", "竞技场使用各职业统一属性。每回合选择一次行动。");
      this.beginRound(b); this.publishQueues(mode);
    }
    this.broadcastPresence();
  }
  leaveQueue(session, notify = true) {
    const mode = session.queueMode;
    if (mode) { this.queues[mode] = this.queues[mode].filter(id => id !== session.id); session.queueMode = null; this.publishQueues(mode); }
    if (notify) this.send(session, { type: "queue_left" });
    this.broadcastPresence();
  }

  beginRound(b) {
    if (b.status !== "active") return;
    b.members.forEach(m => { m.action = null; m.guarding = false; });
    if (b.boss) {
      b.boss.intent = ["focus", "cleave", "recover"][(b.round - 1) % 3];
      const alive = b.members.filter(m => m.hp > 0 && !m.disconnected);
      b.boss.targetId = alive.length ? alive[(b.round - 1) % alive.length].id : null;
    }
    b.deadline = this.now() + LIMITS.roundMs;
    this.cancelTimer(b.timer); b.timer = this.later(() => this.resolveRound(b), LIMITS.roundMs);
    this.publishBattle(b);
  }
  action(session, packet) {
    const b = this.battles.get(session.battleId), m = b?.members.find(member => member.id === session.id);
    if (!b || b.status !== "active" || packet.battleId !== b.id || packet.round !== b.round || !m || m.hp <= 0 || m.disconnected) return this.error(session, "battle_state", "This action does not belong to your active round.", "该行动不属于你当前的有效回合。");
    if (m.action) return this.error(session, "already_acted", "One action per round.", "每回合只能行动一次。");
    if (!["attack", "skill", "guard", "heal"].includes(packet.action)) return this.error(session, "action", "Unknown battle action.", "未知战斗行动。");
    if (packet.action === "skill" && m.skillCd) return this.error(session, "cooldown", "Your skill is cooling down.", "职业技能仍在冷却。");
    if (packet.action === "heal" && !m.heals) return this.error(session, "heals", "No rally charges remain.", "治疗次数已用尽。");
    let targetId = null;
    if (b.kind === "arena" && ["attack", "skill"].includes(packet.action)) {
      const enemies = b.members.filter(other => other.team !== m.team && other.hp > 0 && !other.disconnected);
      const target = packet.targetId ? enemies.find(other => other.id === packet.targetId) : enemies[0];
      if (!target) return this.error(session, "target", "Choose a living opponent.", "请选择存活的对手。");
      targetId = target.id;
    }
    m.action = { kind: packet.action, targetId, explicit: true }; m.contribution++;
    this.publishBattle(b);
    if (b.members.filter(member => member.hp > 0 && !member.disconnected).every(member => member.action)) this.resolveRound(b);
  }
  hit(raw, defense, guarded) {
    const base = Math.max(3, Math.round(raw - defense * .45));
    return guarded ? Math.max(1, Math.ceil(base * .35)) : base;
  }
  resolveRound(b) {
    if (b.status !== "active") return;
    this.cancelTimer(b.timer); b.timer = null;
    const alive = b.members.filter(m => m.hp > 0 && !m.disconnected), usedSkills = new Set();
    for (const m of alive) {
      if (!m.action) m.action = { kind: "guard", targetId: null, explicit: false };
      m.guarding = m.action.kind === "guard" || (m.action.kind === "skill" && m.classId === "vanguard");
      if (m.action.kind === "guard") this.log(b, `${m.alias} guards${m.action.explicit ? "" : " automatically"}.`, `${m.alias}${m.action.explicit ? "选择" : "超时自动"}防御。`);
      if (m.action.kind === "heal") {
        const restored = Math.min(m.maxHp - m.hp, Math.round(m.maxHp * .30));
        m.hp += restored; m.heals--;
        this.log(b, `${m.alias} rallies for ${restored} HP.`, `${m.alias} 自我治疗，恢复 ${restored} 生命。`);
      }
    }
    const damage = new Map();
    for (const m of alive) {
      if (!["attack", "skill"].includes(m.action.kind)) continue;
      const skill = m.action.kind === "skill";
      if (skill) { m.skillCd = 2; usedSkills.add(m.id); }
      const raw = skill ? m.classId === "arcanist" ? m.mag * 1.75 : m.atk * (m.classId === "shadowblade" ? 1.65 : 1.3) : Math.max(m.atk, m.mag * .8);
      const target = b.kind === "raid" ? b.boss : alive.find(other => other.id === m.action.targetId && other.team !== m.team);
      if (!target) continue;
      const amount = this.hit(raw, target.def, target.guarding);
      m.damage += amount; const key = b.kind === "raid" ? "boss" : target.id;
      damage.set(key, (damage.get(key) || 0) + amount);
      this.log(b, `${m.alias} ${skill ? "uses a class skill" : "strikes"} for ${amount}.`, `${m.alias}${skill ? "施展职业技能" : "攻击"}，造成 ${amount} 伤害。`);
    }
    if (b.boss) b.boss.hp = Math.max(0, b.boss.hp - (damage.get("boss") || 0));
    else for (const m of alive) m.hp = Math.max(0, m.hp - (damage.get(m.id) || 0));
    if (b.boss?.hp === 0) { this.finish(b, 0); return; }
    if (b.boss) {
      if (b.boss.phase === 1 && b.boss.hp < b.boss.maxHp * .4) { b.boss.phase = 2; this.log(b, "The Riftwarden becomes enraged!", "裂隙守卫进入狂暴阶段！"); }
      if (b.boss.intent === "recover") {
        const heal = Math.min(b.boss.maxHp - b.boss.hp, Math.round(b.boss.maxHp * .06)); b.boss.hp += heal;
        this.log(b, `The Riftwarden recovers ${heal} HP.`, `裂隙守卫恢复 ${heal} 生命。`);
      } else {
        const targets = b.boss.intent === "cleave" ? alive : alive.filter(m => m.id === b.boss.targetId).slice(0, 1);
        for (const m of targets) {
          const amount = this.hit(b.boss.atk * (b.boss.intent === "focus" ? 1.65 : 1) * (b.boss.phase === 2 ? 1.3 : 1), m.def, m.guarding);
          m.hp = Math.max(0, m.hp - amount);
          this.log(b, `The Riftwarden hits ${m.alias} for ${amount}.`, `裂隙守卫攻击 ${m.alias}，造成 ${amount} 伤害。`);
        }
      }
    }
    for (const m of b.members) if (m.skillCd && !usedSkills.has(m.id)) m.skillCd--;
    if (this.checkEnd(b)) return;
    if (b.round >= LIMITS.rounds) { this.finish(b, null); return; }
    b.round++; this.beginRound(b);
  }
  checkEnd(b) {
    if (b.status !== "active") return true;
    const living = b.members.filter(m => m.hp > 0 && !m.disconnected);
    if (b.kind === "raid") { if (!living.length) { this.finish(b, 1); return true; } }
    else {
      const teams = new Set(living.map(m => m.team));
      if (teams.size < 2) { this.finish(b, teams.size ? [...teams][0] : null); return true; }
    }
    return false;
  }
  finish(b, winningTeam) {
    if (b.status === "finished" || b.resultsSent) return;
    this.cancelTimer(b.timer); b.timer = null; b.status = "finished"; b.deadline = null; b.resultsSent = true;
    this.log(b, winningTeam === null ? "The battle ends in a draw." : "The battle is over.", winningTeam === null ? "战斗以平局结束。" : "战斗结束。");
    this.publishBattle(b);
    for (const m of b.members) {
      const s = this.byId.get(m.id); if (!s || s.battleId !== b.id) continue;
      const outcome = winningTeam === null ? "draw" : m.team === winningTeam ? "victory" : "defeat";
      const eligible = outcome === "victory" && !m.disconnected && m.contribution > 0;
      const reward = eligible ? b.kind === "raid"
        ? { gold: 120 + m.level * 4, xp: 160 + m.level * 4, shards: 2, glory: 5, loot: true }
        : { gold: 35, xp: 60, shards: 1, glory: b.mode === "team" ? 8 : 4, loot: false }
        : zeroReward();
      this.send(s, { type: "battle_result", battleId: b.id, sessionId: s.id, rewardId: `${b.id}:${s.id}`, outcome, eligible, reward });
      s.battleId = null;
    }
    this.broadcastPresence();
    this.later(() => this.battles.delete(b.id), 60000);
  }

  leaveBattle(session, notify = true) {
    const b = this.battles.get(session.battleId); session.battleId = null;
    if (notify) this.send(session, { type: "battle_left" });
    if (!b || b.status === "finished") return;
    if (b.status === "lobby") {
      b.members = b.members.filter(m => m.id !== session.id);
      if (!b.members.length) this.battles.delete(b.id);
      else { if (b.leader === session.id) b.leader = b.members[0].id; this.publishBattle(b); }
    } else {
      const m = b.members.find(member => member.id === session.id);
      if (m) { m.disconnected = true; m.hp = 0; m.action = null; }
      this.log(b, `${session.passport.alias} left the battle.`, `${session.passport.alias} 离开了战斗。`);
      if (!this.checkEnd(b)) {
        const alive = b.members.filter(member => member.hp > 0 && !member.disconnected);
        if (alive.every(member => member.action)) this.resolveRound(b); else this.publishBattle(b);
      }
    }
    this.broadcastPresence();
  }
  disconnect(ws, code = 1000, reason = "Connection closed") {
    const session = this.sessions.get(ws); if (!session) return;
    this.sessions.delete(ws); this.byId.delete(session.id);
    if (session.queueMode) this.leaveQueue(session, false);
    if (session.battleId) this.leaveBattle(session, false);
    try { ws.close(code, reason); } catch {}
    this.broadcastPresence();
    if (!this.sessions.size) { this.cancelTimer(this.sweepTimer); this.sweepTimer = null; }
  }
  sweep() {
    const now = this.now();
    for (const s of [...this.sessions.values()]) {
      if ((!s.ready && now - s.joinedAt >= LIMITS.handshakeMs) || now - s.lastSeen >= LIMITS.idleMs) { this.disconnect(s.ws, 1001, "Session timed out"); continue; }
      if (s.queueMode && now - s.queueSince >= LIMITS.queueMs) { this.leaveQueue(s); this.error(s, "queue_timeout", "Matchmaking expired. Queue again when other players are ready.", "匹配已超时，请在其他玩家准备好后重新排队。"); }
    }
    for (const b of [...this.battles.values()]) if (b.status === "lobby" && now - b.createdAt >= LIMITS.lobbyMs) {
      for (const m of [...b.members]) {
        const s = this.byId.get(m.id);
        if (s?.battleId === b.id) { s.battleId = null; this.send(s, { type: "battle_left" }); this.error(s, "lobby_timeout", "The raid lobby expired.", "副本队伍等待已超时。"); }
      }
      this.battles.delete(b.id); this.broadcastPresence();
    }
  }
  dispose() {
    this.disposed = true;
    for (const ws of [...this.sessions.keys()]) this.disconnect(ws);
    for (const timer of this.timers) this.unschedule(timer);
    this.timers.clear(); this.battles.clear(); this.queues = { duel: [], team: [] };
  }
}
