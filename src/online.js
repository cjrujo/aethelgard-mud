/* v10 live multiplayer. Loaded after core/gameplay/combat/AI scripts. */
var OnlineRealm = (() => {
  const PROTOCOL = 10;
  const runtime = { status: "offline", socket: null, channel: null, sessionId: null, peers: new Map(), players: [], battle: null, queue: null, error: "", timer: null, timeout: null, generation: 0, lastPassport: "", lastResult: null, tabId: null, battleRenderKey: "", clockOffset: 0, lastServerSeen: 0, chatLog: [], chatRenderKey: "" };
  const zh = () => typeof getLang === "function" && getLang() === "zh";
  const tr = (en, cn) => zh() ? cn : en;
  const esc = v => typeof escapeHtml === "function" ? escapeHtml(String(v ?? "")) : String(v ?? "").replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const field = id => document.getElementById(id);
  const text = (id, value) => { const e = field(id); if (e) e.textContent = value; };
  const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
  const note = (en, cn, category = "world") => addLog(en, category, "text-sky-300", cn);

  function appendChat(alias, guild, message, room = state.world.currentRoom) {
    const entry = { alias: String(alias || "Wanderer").slice(0, 20), guild: String(guild || "").slice(0, 8), text: String(message || "").slice(0, 240), room };
    runtime.chatLog.push(entry); runtime.chatLog = runtime.chatLog.slice(-80);
    note(`💬 [${entry.guild}] ${entry.alias}: ${entry.text}`, `💬 【${entry.guild}】${entry.alias}：${entry.text}`);
  }

  function ensureState() {
    state.online = state.online && typeof state.online === "object" ? state.online : {};
    const s = state.online;
    s.alias = String(s.alias || state.player.name || "Wanderer").slice(0, 20);
    s.guildTag = String(s.guildTag || "RIFT").slice(0, 8).toUpperCase();
    s.workerUrl = typeof s.workerUrl === "string" ? s.workerUrl : "";
    s.gloryPoints = Number.isFinite(s.gloryPoints) ? Math.max(0, s.gloryPoints) : 0;
    s.claimedRewards = Array.isArray(s.claimedRewards) ? s.claimedRewards.filter(x => typeof x === "string").slice(-512) : [];
    s.connected = runtime.status === "live" || runtime.status === "tabs";
    s.transport = runtime.status === "tabs" ? "same-browser-tabs" : runtime.status === "live" ? "websocket" : "offline";
    s.partyAllies = []; // v9 fabricated allies must never grant combat damage or reply to chat.
    return s;
  }

  function passport() {
    const s = ensureState(), p = state.player, stats = computeDerivedStats();
    return { alias: s.alias, guild: s.guildTag, room: state.world.currentRoom, classId: p.classId, level: p.level,
      atk: Math.round(stats.atk || 8), mag: Math.round(stats.mag || 8), def: Math.round(stats.def || 0), maxHp: Math.round(p.maxHp || 140) };
  }

  function send(packet) {
    if (!runtime.socket || runtime.socket.readyState !== 1) return false;
    try { runtime.socket.send(JSON.stringify(packet)); return true; }
    catch { runtime.error = tr("Could not send. Reconnect to the realm.", "发送失败，请重新连接领域。"); render(); return false; }
  }

  function disconnect(silent = false) {
    runtime.generation++;
    if (runtime.timer) clearInterval(runtime.timer);
    if (runtime.timeout) clearTimeout(runtime.timeout);
    if (runtime.channel) { try { runtime.channel.postMessage({ protocol: PROTOCOL, kind: "leave", id: runtime.tabId }); runtime.channel.close(); } catch {} }
    if (runtime.socket) { try { runtime.socket.close(1000, "Player disconnected"); } catch {} }
    runtime.socket = null; runtime.channel = null; runtime.timer = null; runtime.timeout = null;
    runtime.status = "offline"; runtime.sessionId = null; runtime.players = []; runtime.peers.clear(); runtime.battle = null; runtime.queue = null; runtime.lastPassport = ""; runtime.lastServerSeen = 0;
    ensureState();
    if (!silent) note("Disconnected. Your offline hero is saved locally.", "已断开连接。离线角色仍保存在本机。");
    render();
  }

  function readSettings() {
    const s = ensureState();
    s.alias = (field("input-online-alias")?.value.trim() || s.alias).slice(0, 20);
    s.guildTag = (field("input-online-guild")?.value.trim() || s.guildTag).slice(0, 8).toUpperCase();
    if (field("input-cf-worker-url")) s.workerUrl = field("input-cf-worker-url").value.trim();
    // The online alias is independent of the offline hero identity.
    saveGameState(false);
    return s;
  }

  function connect() {
    if (["live", "tabs", "connecting"].includes(runtime.status)) { disconnect(); return; }
    const settings = readSettings();
    runtime.error = ""; runtime.lastResult = null; runtime.chatLog = []; runtime.chatRenderKey = "";
    if (!settings.workerUrl) { connectTabs(); return; }
    let url;
    try {
      url = new URL(settings.workerUrl);
      if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("protocol");
      if (url.username || url.password) throw new Error("credentials");
      if (location.protocol === "https:" && url.protocol !== "wss:") throw new Error("secure");
    } catch {
      runtime.error = tr("Enter a wss:// Worker endpoint (or leave it empty for same-browser tabs).", "请输入 wss:// Worker 地址；留空则连接同一浏览器的标签页。"); render(); return;
    }
    const generation = ++runtime.generation;
    runtime.status = "connecting"; render();
    try {
      const socket = new WebSocket(url.href); runtime.socket = socket;
      runtime.timeout = setTimeout(() => {
        if (generation !== runtime.generation || runtime.status !== "connecting") return;
        disconnect(true); runtime.status = "error"; runtime.error = tr("Handshake timed out. Check the Worker address and version.", "连接握手超时，请检查 Worker 地址和版本。"); render();
      }, 12000);
      socket.onmessage = event => {
        if (generation !== runtime.generation) return;
        let packet; try { packet = JSON.parse(event.data); } catch { return; }
        receive(packet);
      };
      socket.onerror = () => { if (generation === runtime.generation) { runtime.error = tr("Connection error. Verify your endpoint and network.", "连接错误，请检查服务地址和网络。"); render(); } };
      socket.onclose = () => {
        if (generation !== runtime.generation) return;
        const error = runtime.error || tr("The realm connection closed. Reconnect to continue.", "领域连接已关闭，请重新连接后继续。");
        disconnect(true); runtime.status = "error"; runtime.error = error; render();
      };
    } catch (error) { disconnect(true); runtime.status = "error"; runtime.error = String(error.message).slice(0, 160); render(); }
  }

  function connectTabs() {
    if (typeof BroadcastChannel === "undefined") { runtime.error = tr("This browser does not support local tab chat. Use a Worker endpoint.", "当前浏览器不支持标签页聊天，请使用 Worker 服务。"); render(); return; }
    runtime.tabId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    runtime.channel = new BroadcastChannel("aethelgard-v10-local-tabs"); runtime.status = "tabs";
    runtime.channel.onmessage = event => {
      const data = event.data;
      if (!data || data.protocol !== PROTOCOL || data.id === runtime.tabId || typeof data.id !== "string") return;
      if (data.kind === "leave") runtime.peers.delete(data.id);
      else if (data.kind === "presence" || data.kind === "hello") {
        const p = data.passport;
        if (!p || typeof p.alias !== "string" || typeof p.room !== "string") return;
        runtime.peers.set(data.id, { id: data.id, alias: p.alias.slice(0, 20), guild: String(p.guild || "").slice(0, 8), room: p.room.slice(0, 90), level: Math.max(1, Math.min(30, Number(p.level) || 1)), seenAt: Date.now() });
        if (data.kind === "hello") announceTab();
      } else if (data.kind === "chat" && runtime.peers.has(data.id)) {
        const peer = runtime.peers.get(data.id);
        if (peer.room === state.world.currentRoom) appendChat(peer.alias, peer.guild, data.text, peer.room);
      }
      render();
    };
    announceTab("hello");
    runtime.timer = setInterval(() => { for (const [id, peer] of runtime.peers) if (Date.now() - peer.seenAt > 30000) runtime.peers.delete(id); announceTab(); render(); }, 10000);
    ensureState(); note("Same-browser tab chat enabled. Internet co-op and arena require a Worker endpoint.", "已启用同一浏览器标签页聊天。跨设备副本和竞技场需要 Worker 服务。"); render();
  }

  function announceTab(kind = "presence") { runtime.channel?.postMessage({ protocol: PROTOCOL, kind, id: runtime.tabId, passport: passport() }); }

  function receive(packet) {
    if (!packet || typeof packet.type !== "string") return;
    runtime.lastServerSeen = Date.now();
    if (Number.isFinite(packet.serverTime)) runtime.clockOffset = packet.serverTime - Date.now();
    if (packet.type === "welcome") {
      if (runtime.status !== "connecting" || typeof packet.sessionId !== "string" || !packet.sessionId || packet.sessionId.length > 100) return;
      if (packet.protocol !== PROTOCOL) { disconnect(true); runtime.status = "error"; runtime.error = tr("The server needs the v10 update.", "服务器需要升级至 v10。"); render(); return; }
      runtime.sessionId = packet.sessionId;
      send({ type: "hello", protocol: PROTOCOL, passport: passport() }); return;
    }
    if (packet.type === "ready") {
      if (runtime.status !== "connecting" || packet.protocol !== PROTOCOL || !runtime.sessionId || packet.sessionId !== runtime.sessionId) return;
      if (runtime.timeout) clearTimeout(runtime.timeout);
      if (runtime.timer) clearInterval(runtime.timer);
      runtime.status = "live"; runtime.error = ""; runtime.lastPassport = JSON.stringify(passport());
      runtime.timer = setInterval(() => {
        if (Date.now() - runtime.lastServerSeen > 90000) {
          disconnect(true); runtime.status = "error"; runtime.error = tr("The realm stopped responding. Reconnect to continue.", "领域服务已停止响应，请重新连接后继续。"); render(); return;
        }
        send({ type: "ping" }); sync(false);
      }, 10000);
      ensureState(); note("Connected to a live realm. Listed companions are actual connected players.", "已连接实时领域。列表中显示的伙伴均来自实际连接。"); render(); return;
    }
    if (packet.type === "error") { runtime.error = zh() ? packet.messageZh || packet.message : packet.message; render(); return; }
    if (runtime.status !== "live") return;
    switch (packet.type) {
      case "presence": runtime.players = Array.isArray(packet.players) ? packet.players.filter(p => p && typeof p.id === "string").slice(0, 100) : []; break;
      case "chat": if (packet.room === state.world.currentRoom) appendChat(packet.alias, packet.guild, packet.text, packet.room); break;
      case "synced": runtime.error = ""; break;
      case "queue":
        if (["duel", "team"].includes(packet.mode) && integer(packet.count, 100) && packet.need === (packet.mode === "team" ? 6 : 2)) {
          runtime.queue = { mode: packet.mode, count: packet.count, need: packet.need }; runtime.battle = null;
        }
        break;
      case "queue_left": runtime.queue = null; break;
      case "battle":
        if (validBattle(packet.battle)) {
          runtime.battle = packet.battle; runtime.queue = null; runtime.error = "";
        }
        break;
      case "battle_result": applyResult(packet); break;
      case "battle_left": runtime.battle = null; break;
    }
    render();
  }

  function validBattle(b) {
    if (!b || typeof b.id !== "string" || b.id.length > 100 || !["raid", "arena"].includes(b.kind) || !["lobby", "active", "finished"].includes(b.status)) return false;
    if (!integer(b.round, 30) || b.round < 1 || !Array.isArray(b.members) || b.members.length < 1 || b.members.length > 6 || !Array.isArray(b.log) || b.log.length > 24) return false;
    if (b.deadline != null && (!Number.isFinite(b.deadline) || b.deadline < 0)) return false;
    const health = m => m && integer(m.maxHp, 100000) && m.maxHp > 0 && integer(m.hp, m.maxHp);
    if (!b.members.every(m => health(m) && typeof m.id === "string" && m.id.length <= 100 && typeof m.alias === "string" && m.alias.length <= 20 && integer(m.team, 1) && integer(m.skillCd, 3) && integer(m.heals, 2))) return false;
    if (!b.members.some(m => m.id === runtime.sessionId) || new Set(b.members.map(m => m.id)).size !== b.members.length) return false;
    if (b.boss && (!health(b.boss) || typeof b.boss.name !== "string" || typeof b.boss.nameZh !== "string" || !["focus", "cleave", "recover"].includes(b.boss.intent))) return false;
    if (b.kind === "raid" && b.status !== "lobby" && !b.boss) return false;
    return b.log.every(e => e && typeof e.en === "string" && typeof e.zh === "string" && e.en.length <= 500 && e.zh.length <= 500);
  }

  function applyResult(packet) {
    const s = ensureState(), b = runtime.battle, reward = packet.reward;
    if (!b || b.status !== "finished" || packet.battleId !== b.id || packet.sessionId !== runtime.sessionId || packet.rewardId !== `${b.id}:${runtime.sessionId}` || s.claimedRewards.includes(packet.rewardId)) return false;
    if (typeof packet.eligible !== "boolean" || !["victory", "defeat", "draw"].includes(packet.outcome) || (packet.eligible && packet.outcome !== "victory")) return false;
    if (!reward || !integer(reward.gold, 1000) || !integer(reward.xp, 1000) || !integer(reward.shards, 10) || !integer(reward.glory, 50) || typeof reward.loot !== "boolean") return false;
    if ((!packet.eligible || packet.outcome !== "victory") && (reward.gold || reward.xp || reward.shards || reward.glory || reward.loot)) return false;
    s.claimedRewards.push(packet.rewardId); s.claimedRewards = s.claimedRewards.slice(-512);
    runtime.lastResult = { outcome: packet.outcome, reward };
    state.player.gold += reward.gold; state.player.xp += reward.xp; state.player.shards += reward.shards; s.gloryPoints += reward.glory;
    if (reward.loot && typeof CombatDirector !== "undefined" && typeof CombatDirector.grantLoot === "function") CombatDirector.grantLoot({ source: "online", level: state.player.level, token: packet.rewardId });
    checkLevelUp();
    const result = packet.outcome === "victory" ? ["Victory", "胜利"] : packet.outcome === "draw" ? ["Draw", "平局"] : ["Defeat", "战败"];
    note(`⚔️ ${result[0]}: +${reward.gold} gold, +${reward.xp} XP, +${reward.shards} shards, +${reward.glory} glory.`, `⚔️ ${result[1]}：+${reward.gold} 金币，+${reward.xp} 经验，+${reward.shards} 碎片，+${reward.glory} 荣耀。`, "combat");
    if (packet.eligible && typeof GameDirector !== "undefined") GameDirector.onAction?.("onlineVictory", { kind: b.kind, battleId: b.id });
    saveGameState(false); renderAll(); return true;
  }

  function sync(verbose = true) {
    if (verbose) readSettings();
    if (runtime.status === "tabs") { announceTab(); if (verbose) note("Announced your location to other local tabs.", "已向其他标签页更新你的位置。"); return; }
    if (runtime.status !== "live") { if (verbose) explainServer(); return; }
    if (isBusy()) { if (verbose) note("Your online expedition locks its starting character stats until you leave the queue or battle.", "联机冒险期间锁定入场属性，请退出匹配或结束战斗后再同步。"); return; }
    const data = passport(), serialized = JSON.stringify(data);
    if (verbose || serialized !== runtime.lastPassport) { send({ type: "sync", passport: data }); runtime.lastPassport = serialized; }
    if (verbose) note("Character snapshot sent to the realm.", "角色快照已发送至领域。");
  }

  function explainServer() {
    runtime.error = tr("Connect to a v10 Cloudflare Worker for raids and arena. Same-browser tab mode supports presence and chat only.", "副本与竞技场需要连接 v10 Cloudflare Worker；标签页模式仅提供在线列表与聊天。"); render(); return false;
  }

  function requireServer() {
    if (runtime.status !== "live") return explainServer();
    if (state.combat?.inCombat) { runtime.error = tr("Finish your solo battle before joining an online expedition.", "请先结束单人战斗，再加入联机冒险。"); render(); return false; }
    runtime.error = ""; return true;
  }

  function joinRaid() { if (requireServer()) { sync(false); send({ type: "raid_join" }); } }
  function startRaid() { if (requireServer()) send({ type: "raid_start" }); }
  function queue(mode = "team") { if (requireServer()) { sync(false); send({ type: "arena_queue", mode: mode === "duel" ? "duel" : "team" }); } }
  function leaveQueue() { send({ type: "queue_leave" }); }
  function leaveBattle() { if (runtime.battle?.status === "finished") { runtime.battle = null; render(); } else send({ type: "battle_leave" }); }
  function isBusy() { return Boolean(runtime.status === "live" && (runtime.queue || (runtime.battle && ["lobby", "active"].includes(runtime.battle.status)))); }

  function act(action) {
    const b = runtime.battle;
    if (runtime.status !== "live" || !b || b.status !== "active") return;
    send({ type: "battle_action", battleId: b.id, round: b.round, action, targetId: action === "heal" ? runtime.sessionId : field("online-battle-target")?.value || null });
  }

  function chat(event) {
    if (event) event.preventDefault();
    const input = field("input-online-chat"), message = input?.value.trim().slice(0, 240);
    if (!message) return;
    if (runtime.status === "live") send({ type: "chat", text: message });
    else if (runtime.status === "tabs") {
      announceTab(); runtime.channel.postMessage({ protocol: PROTOCOL, kind: "chat", id: runtime.tabId, text: message });
      const p = passport(); appendChat(p.alias, p.guild, message);
    } else { runtime.error = tr("Connect before sending a message.", "请先连接，再发送消息。"); render(); return; }
    input.value = ""; render();
  }

  function mount() {
    const modal = field("online-modal");
    if (!modal || field("online-live-ui")) return;
    if (!field("online-v10-styles")) {
      const style = document.createElement("style"); style.id = "online-v10-styles";
      style.textContent = `#online-live-ui{width:min(880px,96vw);max-height:92vh;overflow:auto;background:#101b28;color:#dce9ef;border:1px solid #30615c;border-radius:16px;padding:20px;font-size:13px;box-shadow:0 24px 80px #000b}#online-live-ui h2{font-size:20px;color:#7fe0c5;margin:0}#online-live-ui h3{font-size:14px;color:#b3dfcf;margin:10px 0 6px}#online-live-ui p{line-height:1.6;margin:5px 0;color:#a4b8c6}#online-live-ui .ol-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}#online-live-ui .ol-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}#online-live-ui label{display:block;font-size:11px;color:#a4b8c6;margin-bottom:4px}#online-live-ui input,#online-live-ui select{width:100%;background:#0a1320;border:1px solid #375263;border-radius:7px;padding:8px;color:#e9f4f8;min-width:0}#online-live-ui button{background:#1b3b46;border:1px solid #42616d;border-radius:7px;padding:7px 10px;color:#dce9ef;font:inherit;cursor:pointer}#online-live-ui button:hover{background:#285163}#online-live-ui button:disabled{opacity:.4;cursor:not-allowed}#online-live-ui .ol-primary{background:#187b68;color:white;border-color:#33ab8d}#online-live-ui .ol-box{background:#0c1622;border:1px solid #263c4c;border-radius:10px;padding:10px;margin-top:10px}#online-live-ui .ol-person{padding:6px 0;border-bottom:1px solid #223340;font-size:12px}#online-live-ui .ol-health{height:5px;background:#263546;border-radius:3px;overflow:hidden;margin:4px 0}#online-live-ui .ol-health span{display:block;height:100%;background:#45bc97}#online-live-ui .ol-danger{color:#ffb89b}#online-live-ui .ol-muted{color:#8199ac;font-size:11px}#online-live-ui .ol-log{max-height:140px;overflow:auto;font-size:11px;color:#a7bed0}#online-live-ui .ol-error{color:#ffc19f;white-space:pre-wrap}#online-live-ui [hidden]{display:none!important}@media(max-width:580px){#online-live-ui{padding:12px}.ol-grid{grid-template-columns:1fr!important}}`;
      document.head.appendChild(style);
    }
    modal.innerHTML = `<section id="online-live-ui" role="dialog" aria-modal="true" aria-labelledby="online-live-title">
      <div class="ol-row" style="justify-content:space-between"><h2 id="online-live-title"></h2><button onclick="closeModal('online-modal')" aria-label="Close">✕</button></div>
      <p id="online-live-intro"></p><div class="ol-grid"><div><label id="online-alias-label" for="input-online-alias"></label><input id="input-online-alias" maxlength="20"></div><div><label id="online-guild-label" for="input-online-guild"></label><input id="input-online-guild" maxlength="8"></div></div>
      <div style="margin-top:8px"><label id="online-url-label" for="input-cf-worker-url"></label><input id="input-cf-worker-url" type="url" placeholder="wss://aethelgard-mud-realm.your-name.workers.dev"></div>
      <p class="ol-muted" id="online-transport-help"></p><div class="ol-row"><button id="btn-toggle-online-mode" class="ol-primary" onclick="toggleOnlineMultiplayer()"></button><button id="btn-sync-character-passport" onclick="syncCharacterToOnline()"></button><span id="online-transport-badge"></span><span id="online-glory"></span></div>
      <p id="online-live-error" class="ol-error" role="status" aria-live="polite"></p>
      <div class="ol-grid"><div class="ol-box"><h3 id="online-presence-title"></h3><div id="online-players-list"></div></div><div class="ol-box"><h3 id="online-actions-title"></h3><div class="ol-row"><button id="btn-online-coop-raid" onclick="startOnlineCoopRaid()"></button><button id="btn-online-duel" onclick="OnlineRealm.queue('duel')"></button><button id="btn-online-team-pvp" onclick="startOnlineTeamSkirmish()"></button></div><p id="online-rules-note" class="ol-muted"></p><div id="online-queue-info"></div></div></div>
      <div id="online-battle-card" class="ol-box" hidden></div>
      <div class="ol-box"><h3 id="online-chat-title"></h3><div id="online-chat-log" class="ol-log" role="log" aria-live="polite" style="min-height:60px"></div></div>
      <form id="online-chat-form" onsubmit="sendOnlineChatMessage(event)" class="ol-row" style="margin-top:12px"><input id="input-online-chat" maxlength="240" style="flex:1" autocomplete="off"><button id="btn-send-online-chat" type="submit"></button></form>
      <p class="ol-muted" id="online-save-note"></p>
    </section>`;
    const s = ensureState(); field("input-online-alias").value = s.alias; field("input-online-guild").value = s.guildTag; field("input-cf-worker-url").value = s.workerUrl;
  }

  function renderBattle() {
    const element = field("online-battle-card"); if (!element) return;
    const b = runtime.battle; element.hidden = !b;
    if (!b) { runtime.battleRenderKey = ""; return; }
    const countdown = b.deadline ? Math.max(0, Math.ceil((b.deadline - Date.now() - runtime.clockOffset) / 1000)) : 0;
    const battleRenderKey = JSON.stringify([b, zh(), runtime.lastResult]);
    if (runtime.battleRenderKey === battleRenderKey) { text("online-round-countdown", countdown); return; }
    runtime.battleRenderKey = battleRenderKey;
    const selectedTarget = field("online-battle-target")?.value;
    const own = b.members.find(m => m.id === runtime.sessionId);
    const health = m => `<div class="ol-person">${esc(m.alias || tr(m.name, m.nameZh))}${m.id === runtime.sessionId ? tr(" (you)", "（你）") : ""}${b.kind === "arena" && m.id ? ` · ${tr("Team", "队伍")} ${m.team + 1}` : ""} — ${m.hp}/${m.maxHp} HP${m.acted ? " ✓" : ""}${m.disconnected ? tr(" · left", " · 已离开") : ""}<div class="ol-health"><span style="width:${Math.max(0, Math.min(100, m.hp / Math.max(1, m.maxHp) * 100))}%"></span></div></div>`;
    const enemies = b.members.filter(m => m.team !== own?.team && m.hp > 0);
    const title = b.kind === "raid" ? tr("Co-op Rift Expedition", "裂隙协作副本") : b.mode === "team" ? tr("3v3 Arena", "3v3 竞技场") : tr("Duel", "双人决斗");
    const active = b.status === "active", canAct = active && own?.hp > 0 && !own.acted;
    const intentions = { focus: tr("Focused crush — guard if you draw its attention", "集中重击：承受集火时防御"), cleave: tr("Cleave — every hero will be hit", "横扫：攻击所有队员"), recover: tr("Recover — a chance to strike or heal", "恢复：适合抢攻或治疗") };
    element.innerHTML = `<div class="ol-row" style="justify-content:space-between"><h3>${esc(title)} · ${tr("Round", "回合")} ${b.round}</h3><button onclick="OnlineRealm.leaveBattle()">${b.status === "finished" ? tr("Close result", "关闭结果") : tr("Leave / forfeit", "离开 / 弃权")}</button></div>
      ${b.status === "lobby" ? `<p>${tr("Waiting for 2–4 real players in this room.", "等待同房间 2–4 名真实玩家组队。")}</p>${b.leader === runtime.sessionId ? `<button class="ol-primary" onclick="OnlineRealm.startRaid()" ${b.members.length < 2 ? "disabled" : ""}>${tr("Start expedition", "开启副本")}</button>` : ""}` : ""}
      ${b.boss ? health(b.boss) + `<p class="ol-danger">${esc(intentions[b.boss.intent] || "")}</p>` : ""}
      <div class="ol-grid">${b.members.map(health).join("")}</div>
      ${active ? `<p class="ol-muted">${tr("One action per round. Auto-guard in", "每回合一次行动。自动防御倒计时")} <span id="online-round-countdown">${countdown}</span>s</p>
      ${b.kind === "arena" ? `<label for="online-battle-target">${tr("Opponent", "攻击目标")}</label><select id="online-battle-target">${enemies.map(m => `<option value="${esc(m.id)}" ${m.id === selectedTarget ? "selected" : ""}>${esc(m.alias)} (${m.hp} HP)</option>`).join("")}</select>` : ""}
      <div class="ol-row" style="margin-top:8px"><button onclick="OnlineRealm.act('attack')" ${canAct ? "" : "disabled"}>${tr("Strike", "攻击")}</button><button onclick="OnlineRealm.act('skill')" ${canAct && own.skillCd === 0 ? "" : "disabled"}>${tr("Class skill", "职业技能")} ${own?.skillCd ? `(${own.skillCd})` : ""}</button><button onclick="OnlineRealm.act('guard')" ${canAct ? "" : "disabled"}>${tr("Guard", "防御")}</button><button onclick="OnlineRealm.act('heal')" ${canAct && own.heals > 0 ? "" : "disabled"}>${tr("Rally self", "自我治疗")} (${own?.heals ?? 0})</button></div>` : ""}
      ${b.status === "finished" ? `<p>${esc(tr("Battle finished. Rewards are granted only from a verified server result.", "战斗结束，仅根据服务器结算发放奖励。"))}</p>` : ""}
      <div class="ol-log" style="margin-top:10px">${(b.log || []).slice(-12).map(entry => `<div>${esc(zh() ? entry.zh : entry.en)}</div>`).join("")}</div>`;
  }

  function renderSetBonuses() {
    const el = field("set-bonus-status-list"); if (!el || typeof DIABLO_SETS === "undefined") return;
    const counts = typeof getEquippedSetCounts === "function" ? getEquippedSetCounts() : {};
    el.innerHTML = Object.values(DIABLO_SETS).map(set => `<div class="text-[10px] py-1 border-b border-slate-800"><strong>${esc(zh() ? set.nameZh : set.name)} (${counts[set.id] || 0}/4)</strong><div>${esc(zh() ? set.bonus2Zh : set.bonus2En)} · ${esc(zh() ? set.bonus4Zh : set.bonus4En)}</div></div>`).join("");
  }

  function render() {
    const s = ensureState(); renderSetBonuses();
    const labels = { offline: tr("Offline", "离线"), connecting: tr("Connecting…", "连接中…"), live: tr("Realm connected", "实时领域已连接"), tabs: tr("Local tabs", "本机标签页"), error: tr("Disconnected", "未连接") };
    text("online-status-dot", labels[runtime.status] || labels.offline);
    if (!field("online-live-ui")) return;
    text("online-live-title", tr("Companions & Live Expeditions", "伙伴与联机冒险"));
    text("online-live-intro", tr("Meet real explorers. Read the boss intent, coordinate your turns and earn the outcome together.", "与真实冒险者相遇。观察首领意图、配合回合行动，共同赢得战果。"));
    text("online-alias-label", tr("Online alias", "联机昵称")); text("online-guild-label", tr("Team tag", "队伍标记")); text("online-url-label", tr("Cloudflare Worker WebSocket endpoint", "Cloudflare Worker WebSocket 地址"));
    text("online-transport-help", tr("Empty endpoint = chat between tabs of this browser only. A deployed Worker enables cross-device play.", "地址留空：仅同一浏览器标签页聊天。部署 Worker 后可跨设备联机。"));
    text("btn-toggle-online-mode", ["live", "tabs", "connecting"].includes(runtime.status) ? tr("Disconnect", "断开连接") : tr("Connect", "连接"));
    text("btn-sync-character-passport", tr("Sync character", "同步角色")); text("online-transport-badge", labels[runtime.status] || ""); text("online-glory", `${tr("Glory", "荣耀")}: ${s.gloryPoints}`); text("online-live-error", runtime.error || "");
    text("online-presence-title", tr("Explorers in this room", "当前房间的冒险者")); text("online-actions-title", tr("Choose an expedition", "选择联机玩法"));
    text("btn-online-coop-raid", tr("Co-op raid (2–4)", "协作副本（2–4人）")); text("btn-online-duel", tr("Duel (1v1)", "决斗（1v1）")); text("btn-online-team-pvp", tr("Team arena (3v3)", "队伍竞技（3v3）"));
    text("online-rules-note", tr("Raid HP is instanced. Arena stats are equalized. No rewards for joining, waiting or disconnecting before you contribute.", "副本使用独立血量；竞技场统一基础属性。加入、排队或未参与即离线均不会获得奖励。"));
    text("online-save-note", tr("Offline saves stay on your device. This is cooperative / friendly competition, not an anti-cheat ranked service.", "离线存档保留在本机。当前提供协作与友谊竞技，不宣称具备防作弊排位系统。"));
    text("btn-send-online-chat", tr("Send", "发送")); if (field("input-online-chat")) field("input-online-chat").placeholder = tr("Chat with explorers in this room…", "与同房间冒险者聊天……");
    text("online-chat-title", tr("Room messages", "房间消息"));
    const chatLog = field("online-chat-log"), chatEntries = runtime.chatLog.filter(e => e.room === state.world.currentRoom), chatKey = JSON.stringify([chatEntries, zh()]);
    if (chatLog && chatKey !== runtime.chatRenderKey) {
      const nearEnd = chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 24;
      chatLog.innerHTML = chatEntries.length ? chatEntries.map(e => `<div class="ol-person"><strong>${esc(e.alias)}</strong> [${esc(e.guild)}]: ${esc(e.text)}</div>`).join("") : `<p>${tr("Messages from this room will appear here.", "同房间的消息将显示在这里。")}</p>`;
      if (nearEnd) chatLog.scrollTop = chatLog.scrollHeight;
      runtime.chatRenderKey = chatKey;
    }
    const self = { ...passport(), id: runtime.status === "tabs" ? runtime.tabId : runtime.sessionId, guild: s.guildTag };
    const players = runtime.status === "tabs" ? [self, ...runtime.peers.values()] : runtime.players;
    const here = players.filter(p => p.room === state.world.currentRoom);
    const list = field("online-players-list");
    if (list) list.innerHTML = here.length ? here.map(p => `<div class="ol-person"><strong>${esc(p.alias)}</strong> [${esc(p.guild)}] · Lv.${Math.max(1, Number(p.level) || 1)}${p.id === self.id ? tr(" · you", " · 你") : ""}${p.activity ? ` · ${esc(p.activity)}` : ""}</div>`).join("") : `<p class="ol-muted">${tr("No connected explorers here yet.", "这里暂时没有已连接的冒险者。")}</p>`;
    const q = field("online-queue-info"); if (q) q.innerHTML = runtime.queue ? `<p>${tr("Matchmaking", "匹配中")} ${runtime.queue.count}/${runtime.queue.need} · ${runtime.queue.mode === "team" ? "3v3" : "1v1"}</p><button onclick="OnlineRealm.leaveQueue()">${tr("Leave queue", "退出匹配")}</button>` : "";
    for (const id of ["btn-online-coop-raid", "btn-online-duel", "btn-online-team-pvp"]) if (field(id)) field(id).disabled = runtime.status !== "live" || isBusy();
    renderBattle();
  }

  function open() {
    mount(); const s = ensureState();
    if (field("input-online-alias")) field("input-online-alias").value = s.alias;
    if (field("input-online-guild")) field("input-online-guild").value = s.guildTag;
    if (field("input-cf-worker-url")) field("input-cf-worker-url").value = s.workerUrl;
    render(); openModal("online-modal");
  }
  if (typeof window !== "undefined") window.addEventListener("beforeunload", () => disconnect(true));
  return { ensureState, passport, connect, disconnect, open, render, sync, chat, joinRaid, startRaid, queue, leaveQueue, leaveBattle, act, isBusy,
    getStatus: () => ({ status: runtime.status, sessionId: runtime.sessionId, playerCount: runtime.players.length, battleId: runtime.battle?.id || null }) };
})();

function ensureOnlineState() { return OnlineRealm.ensureState(); }
function openOnlineModal() { OnlineRealm.open(); }
function toggleOnlineMultiplayer() { OnlineRealm.connect(); }
function syncCharacterToOnline() { OnlineRealm.sync(true); }
function startOnlineCoopRaid() { OnlineRealm.open(); OnlineRealm.joinRaid(); }
function startOnlineTeamSkirmish() { OnlineRealm.open(); OnlineRealm.queue("team"); }
function sendOnlineChatMessage(event) { OnlineRealm.chat(event); }
function renderOnlineHubUI() { OnlineRealm.render(); }
