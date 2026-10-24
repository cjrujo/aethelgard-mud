/* v11 live multiplayer. Loaded after core/gameplay/combat/AI scripts. */
var OnlineRealm = (() => {
  const PROTOCOL = 11;
  const REQUEST_MS = 12000;
  const build = window.AETHELGARD_BUILD || { version: "11.0.0", id: "development", protocol: PROTOCOL };
  const runtime = { status: "offline", socket: null, channel: null, sessionId: null, peers: new Map(), players: [], battle: null, queue: null, error: "", timer: null, timeout: null, generation: 0, lastPassport: "", lastResult: null, tabId: null, battleRenderKey: "", clockOffset: 0, lastServerSeen: 0, chatLog: [], chatRenderKey: "", pending: null, pendingTimer: null, serverBuild: null, serverProtocol: null, endpoint: "", heroId: null, identityToken: null, receiptInfo: null, receiptMessage: "", lastReceiptSync: 0, closeCode: null };
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

  const record = value => value && typeof value === "object" && !Array.isArray(value);
  const validHero = value => typeof value === "string" && /^h-[a-f0-9]{32}$/.test(value);
  const validToken = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const canWrite = () => window.AethelgardApp?.canWrite?.() !== false;
  function writable() {
    if (canWrite()) return true;
    runtime.error = tr("This hero is read-only in this tab. Take over its save before connecting or claiming rewards.", "此标签页的英雄存档为只读，请先接管存档，再连接或领取奖励。"); render(); return false;
  }
  function secureHex(bytes) {
    if (!globalThis.crypto?.getRandomValues) throw new Error(tr("Secure browser storage identity is unavailable.", "当前浏览器无法生成安全恢复身份。"));
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2, "0")).join("");
  }
  function ensureIdentity(endpoint) {
    const s = ensureState(), before = JSON.parse(JSON.stringify(s));
    if (!validHero(s.heroId)) s.heroId = "h-" + secureHex(16);
    if (!validToken(s.recoveryTokens[endpoint])) s.recoveryTokens[endpoint] = secureHex(32);
    if (saveGameState(false) !== true) {
      state.online = before;
      throw new Error(tr("Save this hero successfully before connecting. Its recovery token must survive a refresh.", "请先成功保存英雄再连接；恢复凭证必须在刷新后仍然可用。"));
    }
    return { heroId: s.heroId, token: s.recoveryTokens[endpoint] };
  }

  function ensureState() {
    state.online = record(state.online) ? state.online : {};
    const s = state.online;
    s.alias = String(s.alias || state.player.name || "Wanderer").slice(0, 20);
    s.guildTag = String(s.guildTag || "RIFT").slice(0, 8).toUpperCase();
    s.workerUrl = typeof s.workerUrl === "string" ? s.workerUrl : "";
    s.gloryPoints = Number.isFinite(s.gloryPoints) ? Math.max(0, s.gloryPoints) : 0;
    s.claimedRewards = Array.isArray(s.claimedRewards) ? s.claimedRewards.filter(x => typeof x === "string").slice(-512) : [];
    if (!validHero(s.heroId)) s.heroId = null;
    s.recoveryTokens = record(s.recoveryTokens) ? Object.fromEntries(Object.entries(s.recoveryTokens).filter(([key, token]) => key.length < 2048 && validToken(token))) : {};
    s.receiptProgress = record(s.receiptProgress) ? s.receiptProgress : {};
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

  function clearPending() {
    if (runtime.pendingTimer !== null) clearTimeout(runtime.pendingTimer);
    runtime.pendingTimer = null; runtime.pending = null;
  }
  function send(packet) {
    if (!runtime.socket || runtime.socket.readyState !== 1) {
      if (["live", "connecting"].includes(runtime.status)) {
        disconnect(true); runtime.status = "error"; runtime.error = tr("The socket is no longer open. Reconnect to continue.", "连接已关闭，请重新连接后继续。"); render();
      }
      return false;
    }
    try { runtime.socket.send(JSON.stringify(packet)); return true; }
    catch {
      disconnect(true); runtime.status = "error";
      runtime.error = tr("The connection failed. Your saved reward receipts can be recovered when you reconnect.", "连接发送失败。重新连接后可补领已保存的战斗奖励。"); render(); return false;
    }
  }
  function disconnect(silent = false) {
    const wasBattle = runtime.battle && ["lobby", "active", "settling"].includes(runtime.battle.status);
    runtime.generation++; clearPending();
    if (runtime.timer) clearInterval(runtime.timer);
    if (runtime.timeout) clearTimeout(runtime.timeout);
    if (runtime.channel) { try { runtime.channel.postMessage({ protocol: PROTOCOL, kind: "leave", id: runtime.tabId }); runtime.channel.close(); } catch {} }
    if (runtime.socket) { try { runtime.socket.close(1000, "Player disconnected"); } catch {} }
    runtime.socket = null; runtime.channel = null; runtime.timer = null; runtime.timeout = null;
    runtime.status = "offline"; runtime.sessionId = null; runtime.players = []; runtime.peers.clear(); runtime.battle = null; runtime.queue = null; runtime.lastPassport = "";
    runtime.heroId = null; runtime.identityToken = null; runtime.receiptInfo = null; runtime.receiptMessage = ""; runtime.lastResult = null;
    ensureState();
    if (!silent) note(wasBattle ? "You left the online expedition. Finished rewards remain recoverable; an active battle cannot be resumed." : "Disconnected from the realm. Your local journey can continue.",
      wasBattle ? "已离开联机对局。已保存的结算仍可补领，进行中的战斗不能重连恢复。" : "已断开领域连接，可以继续本地旅程。");
    render();
  }
  function readSettings() {
    const s = ensureState();
    if (!writable()) return null;
    s.alias = (field("input-online-alias")?.value.trim() || s.alias).slice(0, 20);
    s.guildTag = (field("input-online-guild")?.value.trim() || s.guildTag).slice(0, 8).toUpperCase();
    if (field("input-cf-worker-url")) s.workerUrl = field("input-cf-worker-url").value.trim();
    if (saveGameState(false) !== true) { runtime.error = tr("Save this hero successfully before changing online settings.", "请先成功保存英雄，再更新联机设置。"); render(); return null; }
    return s;
  }
  function connect() {
    if (["live", "tabs", "connecting"].includes(runtime.status)) { disconnect(); return; }
    const settings = readSettings(); if (!settings) return;
    runtime.error = ""; runtime.lastResult = null; runtime.chatLog = []; runtime.chatRenderKey = "";
    runtime.receiptMessage = ""; runtime.receiptInfo = null; runtime.closeCode = null; runtime.lastServerSeen = 0;
    runtime.serverBuild = null; runtime.serverProtocol = null;
    if (!settings.workerUrl) { connectTabs(); return; }
    let url, identity;
    try {
      url = new URL(settings.workerUrl);
      if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.href.length >= 2048) throw new Error("endpoint");
      if (location.protocol === "https:" && url.protocol !== "wss:") throw new Error("endpoint");
      url.hash = "";
      // Equivalent endpoint paths share a recovery namespace for the same realm.
      const realmKey = url.origin + "?realm=" + encodeURIComponent(url.searchParams.get("realm") || "global-shard-1");
      identity = ensureIdentity(realmKey); runtime.endpoint = url.href;
      runtime.identityKey = realmKey; runtime.heroId = identity.heroId; runtime.identityToken = identity.token;
    } catch (error) {
      runtime.error = error.message === "endpoint" ? tr("Enter a wss:// Worker endpoint (or leave it empty for same-browser tabs).", "请输入 wss:// Worker 地址；留空则连接同一浏览器标签页。") : String(error.message); render(); return;
    }
    const generation = ++runtime.generation;
    runtime.status = "connecting"; render();
    try {
      const socket = new WebSocket(url.href); runtime.socket = socket;
      runtime.timeout = setTimeout(() => {
        if (generation !== runtime.generation || runtime.status !== "connecting") return;
        disconnect(true); runtime.status = "error"; runtime.error = tr("Handshake timed out. Check the Worker address and both build versions.", "连接握手超时，请检查 Worker 地址及前后端版本。"); render();
      }, REQUEST_MS);
      socket.onmessage = event => {
        if (generation !== runtime.generation) return;
        let packet; try { packet = JSON.parse(event.data); } catch { return; }
        receive(packet);
      };
      socket.onerror = () => { if (generation === runtime.generation) { runtime.error = tr("Connection error. Check your endpoint and network, then reconnect.", "连接错误，请检查服务地址和网络后重新连接。"); render(); } };
      socket.onclose = event => {
        if (generation !== runtime.generation) return;
        const playing = runtime.battle && ["lobby", "active"].includes(runtime.battle.status);
        const error = runtime.error || (playing ? tr("Connection closed: you left the active battle. Reconnect to recover already recorded results.", "连接中断：已退出当前对局。重新连接后可补领已保存的结算。") : tr("The realm connection closed. Reconnect to continue and recover pending rewards.", "领域连接已关闭。重新连接即可继续并补领待收奖励。"));
        runtime.closeCode = event?.code || null;
        disconnect(true); runtime.status = "error"; runtime.error = error; render();
      };
    } catch (error) { disconnect(true); runtime.status = "error"; runtime.error = String(error.message).slice(0, 160); render(); }
  }

  function connectTabs() {
    if (typeof BroadcastChannel === "undefined") { runtime.error = tr("This browser does not support local tab chat. Use a Worker endpoint.", "当前浏览器不支持标签页聊天，请使用 Worker 服务。"); render(); return; }
    runtime.tabId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    runtime.channel = new BroadcastChannel("aethelgard-v11-local-tabs"); runtime.status = "tabs";
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
      runtime.serverProtocol = packet.protocol; runtime.serverBuild = packet.build || null;
      if (packet.protocol !== PROTOCOL) {
        const message = tr(`Client protocol ${PROTOCOL} cannot use server protocol ${packet.protocol}. Update the Cloudflare Worker and refresh the game together.`, `客户端协议 ${PROTOCOL} 与服务器协议 ${packet.protocol} 不匹配，请更新 Cloudflare Worker 并刷新游戏。`);
        disconnect(true); runtime.status = "error"; runtime.error = message; render(); return;
      }
      runtime.sessionId = packet.sessionId;
      send({ type: "hello", protocol: PROTOCOL, build, passport: passport(), identity: { heroId: runtime.heroId, token: runtime.identityToken } }); return;
    }
    if (packet.type === "ready") {
      if (runtime.status !== "connecting" || packet.protocol !== PROTOCOL || !runtime.sessionId || packet.sessionId !== runtime.sessionId || packet.heroId !== runtime.heroId || !validReceiptInfo(packet.receipts)) return;
      if (!canWrite() || !identityMatches()) {
        disconnect(true); runtime.status = "error"; runtime.error = tr("This hero changed or lost save ownership during connection. Take over its save and reconnect.", "连接期间英雄已切换或本页失去存档写权，请接管对应存档后重新连接。"); render(); return;
      }
      if (runtime.timeout) clearTimeout(runtime.timeout);
      if (runtime.timer) clearInterval(runtime.timer);
      runtime.status = "live"; runtime.error = ""; runtime.lastPassport = JSON.stringify(passport());
      runtime.serverBuild = packet.build || runtime.serverBuild; updateReceiptInfo(packet.receipts);
      runtime.lastReceiptSync = Date.now();
      runtime.timer = setInterval(() => {
        if (!canWrite()) { disconnect(true); return; }
        if (Date.now() - runtime.lastServerSeen > 90000) {
          disconnect(true); runtime.status = "error"; runtime.error = tr("The realm stopped responding. Reconnect to recover saved results.", "领域服务已停止响应，请重新连接以恢复已保存的结算。"); render(); return;
        }
        send({ type: "ping" }); sync(false);
        if (runtime.receiptInfo?.pending > 0 && Date.now() - runtime.lastReceiptSync >= 10000) retryRewards(false);
        render();
      }, 10000);
      ensureState(); note("Connected to the realm. Recorded rewards can be recovered by this saved hero.", "已连接实时领域。此英雄存档可补领已记录的战斗奖励。"); render(); return;
    }
    if (packet.type === "error") {
      const message = zh() ? packet.messageZh || packet.message : packet.message;
      if (runtime.pending && packet.requestId === runtime.pending.requestId) {
        clearPending();
        if (packet.code === "busy") { disconnect(true); runtime.status = "error"; }
      }
      if (runtime.status === "connecting" || ["session_replaced", "protocol", "identity_mismatch"].includes(packet.code)) { disconnect(true); runtime.status = "error"; }
      runtime.error = message; render(); return;
    }
    if (runtime.status !== "live") return;
    switch (packet.type) {
      case "presence": runtime.players = Array.isArray(packet.players) ? packet.players.filter(p => p && typeof p.id === "string").slice(0, 100) : []; break;
      case "chat": if (packet.room === state.world.currentRoom) appendChat(packet.alias, packet.guild, packet.text, packet.room); break;
      case "synced": if (!runtime.pending) runtime.error = ""; break;
      case "queue":
        if (["duel", "team"].includes(packet.mode) && integer(packet.count, 100) && packet.need === (packet.mode === "team" ? 6 : 2)) {
          if (runtime.pending?.kind === "queueing") clearPending();
          runtime.queue = { mode: packet.mode, count: packet.count, need: packet.need }; runtime.battle = null;
        }
        break;
      case "queue_left": clearPending(); runtime.queue = null; note("Left matchmaking. Your local journey is available again.", "已退出匹配，可以继续本地旅程。"); break;
      case "battle":
        if (validBattle(packet.battle)) {
          if (["joining", "queueing"].includes(runtime.pending?.kind) || (runtime.pending?.kind === "starting" && packet.battle.status !== "lobby")) clearPending();
          runtime.battle = packet.battle; runtime.queue = null; runtime.error = "";
        }
        break;
      case "battle_result": applyResult(packet); break;
      case "battle_left": clearPending(); runtime.battle = null; note("You left the expedition. Leaving an active battle counts as a forfeit.", "已离开联机队伍；离开正在进行的战斗按弃权处理。"); break;
      case "pong": case "receipts_status": case "receipt_acked":
        if (validReceiptInfo(packet.receipts) && packet.receipts.ledgerId === runtime.receiptInfo?.ledgerId) updateReceiptInfo(packet.receipts);
        break;
    }
    render();
  }

  function validBattle(b) {
    if (!b || typeof b.id !== "string" || b.id.length > 100 || !["raid", "arena"].includes(b.kind) || !["lobby", "active", "settling", "finished"].includes(b.status)) return false;
    if (!integer(b.round, 30) || b.round < 1 || !Array.isArray(b.members) || b.members.length < 1 || b.members.length > 6 || !Array.isArray(b.log) || b.log.length > 24) return false;
    if (b.deadline != null && (!Number.isFinite(b.deadline) || b.deadline < 0)) return false;
    const health = m => m && integer(m.maxHp, 100000) && m.maxHp > 0 && integer(m.hp, m.maxHp);
    if (!b.members.every(m => health(m) && typeof m.id === "string" && m.id.length <= 100 && typeof m.alias === "string" && m.alias.length <= 20 && integer(m.team, 1) && integer(m.skillCd, 3) && integer(m.heals, 2))) return false;
    if (!b.members.some(m => m.id === runtime.sessionId) || new Set(b.members.map(m => m.id)).size !== b.members.length) return false;
    if (b.boss && (!health(b.boss) || typeof b.boss.name !== "string" || typeof b.boss.nameZh !== "string" || !["focus", "cleave", "recover"].includes(b.boss.intent))) return false;
    if (b.kind === "raid" && b.status !== "lobby" && !b.boss) return false;
    return b.log.every(e => e && typeof e.en === "string" && typeof e.zh === "string" && e.en.length <= 500 && e.zh.length <= 500);
  }

  function validReceiptInfo(info) {
    return info && typeof info.ledgerId === "string" && /^l-[A-Za-z0-9-]{1,96}$/.test(info.ledgerId) && Number.isSafeInteger(info.floor) && info.floor >= 0 && integer(info.pending, 128);
  }
  function progress(ledgerId) {
    const s = ensureState(), value = s.receiptProgress[ledgerId];
    const entry = record(value) ? value : {};
    entry.through = Number.isSafeInteger(entry.through) && entry.through >= 0 ? entry.through : 0;
    entry.seen = Array.isArray(entry.seen) ? [...new Set(entry.seen.filter(n => Number.isSafeInteger(n) && n > entry.through))].sort((a, b) => a - b) : [];
    s.receiptProgress[ledgerId] = entry; return entry;
  }
  function updateReceiptInfo(info) {
    runtime.receiptInfo = info;
    // Server floor only skips receipts that this hero has already acknowledged.
    if (canWrite() && ensureState().heroId === runtime.heroId) {
      const p = progress(info.ledgerId); p.through = Math.max(p.through, info.floor); p.seen = p.seen.filter(n => n > p.through);
    }
    if (!info.pending && runtime.receiptMessage) runtime.receiptMessage = tr("All recorded rewards are saved to this hero.", "已记录的奖励均已存入此英雄。");
  }
  function identityMatches() {
    const s = ensureState();
    return s.heroId === runtime.heroId && s.recoveryTokens[runtime.identityKey] === runtime.identityToken;
  }
  function acknowledge(packet) { return send({ type: "receipt_ack", ledgerId: packet.ledgerId, sequence: packet.sequence, rewardId: packet.rewardId }); }
  function applyResult(packet) {
    const reward = packet.reward, info = runtime.receiptInfo;
    if (!identityMatches() || !info || packet.heroId !== runtime.heroId || packet.sessionId !== runtime.sessionId || packet.ledgerId !== info.ledgerId || !Number.isSafeInteger(packet.sequence) || packet.sequence < 1 || packet.rewardId !== `${info.ledgerId}:${packet.sequence}`) return false;
    if (typeof packet.battleId !== "string" || packet.battleId.length > 100 || !["raid", "arena"].includes(packet.kind)) return false;
    if (runtime.battle?.id === packet.battleId && runtime.battle.status !== "finished") return false;
    if (typeof packet.eligible !== "boolean" || !["victory", "defeat", "draw"].includes(packet.outcome) || (packet.eligible && packet.outcome !== "victory")) return false;
    if (!reward || !integer(reward.gold, 1000) || !integer(reward.xp, 1000) || !integer(reward.shards, 10) || !integer(reward.glory, 50) || typeof reward.loot !== "boolean") return false;
    if ((!packet.eligible || packet.outcome !== "victory") && (reward.gold || reward.xp || reward.shards || reward.glory || reward.loot)) return false;
    if (!writable()) { runtime.receiptMessage = tr("Rewards are waiting on the server. Take over this hero's save to collect them.", "奖励仍在服务器等待领取，请先接管此英雄存档。"); return false; }
    const p = progress(info.ledgerId);
    if (packet.sequence <= p.through || p.seen.includes(packet.sequence) || ensureState().claimedRewards.includes(packet.rewardId)) {
      if (saveGameState(false) === true) acknowledge(packet);
      return true;
    }
    const before = JSON.parse(JSON.stringify(state));
    const catalogs = [WORLD_ROOMS, MOB_TEMPLATES, ITEM_CATALOG].map(target => [target, JSON.parse(JSON.stringify(target))]);
    try {
      if (p.seen.length >= 4096) throw new Error("Receipt history needs recovery");
      p.seen.push(packet.sequence); p.seen.sort((a, b) => a - b);
      while (p.seen[0] === p.through + 1) { p.through++; p.seen.shift(); }
      const s = ensureState();
      state.player.gold += reward.gold; state.player.xp += reward.xp; state.player.shards += reward.shards; s.gloryPoints += reward.glory;
      if (reward.loot && typeof CombatDirector !== "undefined" && typeof CombatDirector.grantLoot === "function") CombatDirector.grantLoot({ source: "online", level: state.player.level, token: packet.rewardId });
      checkLevelUp();
      if (packet.eligible && typeof GameDirector !== "undefined") GameDirector.onAction?.("onlineVictory", { kind: packet.kind, battleId: packet.battleId });
      if (saveGameState(false) !== true) throw new Error("Save was not written");
    } catch (_) {
      state = before;
      for (const [target, saved] of catalogs) { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, saved); }
      runtime.receiptMessage = tr("Reward is still waiting on the server: local saving failed. Free space or take over this save, then collect again.", "奖励仍保留在服务器：本地存档未成功。请腾出空间或接管存档后重新领取。");
      renderAll(); return false;
    }
    runtime.lastResult = { outcome: packet.outcome, reward, battleId: packet.battleId };
    runtime.receiptMessage = tr("Battle reward saved. Confirming receipt with the realm…", "战斗奖励已存入英雄，正在向领域确认……");
    const result = packet.outcome === "victory" ? ["Victory", "胜利"] : packet.outcome === "draw" ? ["Draw", "平局"] : ["Defeat", "战败"];
    note(`⚔️ ${result[0]} saved: +${reward.gold} gold, +${reward.xp} XP, +${reward.shards} shards, +${reward.glory} glory.`, `⚔️ ${result[1]}已保存：+${reward.gold} 金币，+${reward.xp} 经验，+${reward.shards} 碎片，+${reward.glory} 荣耀。`, "combat");
    acknowledge(packet); renderAll(); return true;
  }
  function retryRewards(verbose = true) {
    if (runtime.status !== "live" || !writable()) return false;
    runtime.lastReceiptSync = Date.now();
    if (verbose) runtime.receiptMessage = tr("Checking this hero's pending rewards…", "正在检查此英雄的待领取奖励……");
    const ok = send({ type: "receipt_sync" }); render(); return ok;
  }

  function sync(verbose = true) {
    if (!writable()) return false;
    if (verbose && !readSettings()) return false;
    if (runtime.status === "tabs") { announceTab(); if (verbose) note("Announced your location to other local tabs.", "已向其他标签页更新你的位置。"); return; }
    if (runtime.status !== "live") { if (verbose) explainServer(); return; }
    if (isBusy()) { if (verbose) note("Your online expedition locks its starting character stats until you leave the queue or battle.", "联机冒险期间锁定入场属性，请退出匹配或结束战斗后再同步。"); return; }
    const data = passport(), serialized = JSON.stringify(data);
    if (verbose || serialized !== runtime.lastPassport) { if (send({ type: "sync", passport: data })) runtime.lastPassport = serialized; }
    if (verbose) note("Character snapshot sent to the realm.", "角色快照已发送至领域。");
  }

  function explainServer() {
    runtime.error = tr("Connect to a v11 Cloudflare Worker for raids and arena. Same-browser tab mode supports presence and chat only.", "副本与竞技场需要连接 v11 Cloudflare Worker；标签页模式仅提供在线列表与聊天。"); render(); return false;
  }

  function requireServer() {
    if (runtime.status !== "live") return explainServer();
    if (!writable() || !identityMatches()) return false;
    if (state.combat?.inCombat) { runtime.error = tr("Finish your solo battle before joining an online expedition.", "请先结束单人战斗，再加入联机冒险。"); render(); return false; }
    runtime.error = ""; return true;
  }
  function request(kind, packet) {
    if (runtime.pending || !requireServer()) return false;
    const requestId = "q-" + secureHex(12), generation = runtime.generation;
    runtime.pending = { kind, requestId, sentAt: Date.now() };
    // Lock before either send or render; even an immediate auto-hunt tick sees it.
    if (typeof CombatDirector !== "undefined") CombatDirector.stopHunt?.("online");
    state.autoHunt = false;
    if (typeof autoWalkHandle !== "undefined" && autoWalkHandle) { clearInterval(autoWalkHandle); autoWalkHandle = null; }
    runtime.pendingTimer = setTimeout(() => {
      if (generation !== runtime.generation || runtime.pending?.requestId !== requestId) return;
      // Closing the socket removes an unacknowledged server-side queue/battle too.
      disconnect(true); runtime.status = "error"; runtime.error = tr("The request timed out. Disconnected to cancel it safely; reconnect when ready.", "请求超时，已断开连接以取消可能仍在进行的匹配，请准备好后重连。"); render();
    }, REQUEST_MS);
    if (kind === "joining" || kind === "queueing") {
      const data = passport();
      if (JSON.stringify(data) !== runtime.lastPassport) {
        if (!send({ type: "sync", passport: data })) return false;
        runtime.lastPassport = JSON.stringify(data);
      }
    }
    const sent = send({ ...packet, requestId });
    if (!sent) clearPending();
    renderAll(); return sent;
  }
  function joinRaid() { if (!isBusy()) return request("joining", { type: "raid_join" }); return false; }
  function startRaid() { if (runtime.battle?.status === "lobby") return request("starting", { type: "raid_start" }); return false; }
  function queue(mode = "team") { if (!isBusy()) return request("queueing", { type: "arena_queue", mode: mode === "duel" ? "duel" : "team" }); return false; }
  function leaveQueue() { if (runtime.queue && !runtime.pending) return request("leaving", { type: "queue_leave" }); return false; }
  function leaveBattle() {
    if (runtime.battle?.status === "finished") { runtime.battle = null; render(); return true; }
    if (runtime.battle && !runtime.pending) return request("leaving", { type: "battle_leave" }); return false;
  }
  function cancelPending() { disconnect(); }
  function isBusy() { return Boolean(runtime.status === "live" && (runtime.pending || runtime.queue || (runtime.battle && ["lobby", "active", "settling"].includes(runtime.battle.status)))); }

  function act(action) {
    const b = runtime.battle;
    if (runtime.status !== "live" || runtime.pending || !b || b.status !== "active" || !writable()) return;
    send({ type: "battle_action", battleId: b.id, round: b.round, action, targetId: action === "heal" ? runtime.sessionId : field("online-battle-target")?.value || null });
  }

  function chat(event) {
    if (!writable()) return;
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
    if (!field("online-v11-styles")) {
      const style = document.createElement("style"); style.id = "online-v11-styles";
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
      <div class="ol-box"><h3 id="online-reward-title"></h3><p id="online-reward-status" role="status"></p><button id="online-retry-rewards" onclick="OnlineRealm.retryRewards()"></button></div>
      <details class="ol-box"><summary id="online-diagnostics-title"></summary><p id="online-diagnostics" class="ol-muted"></p><button id="online-copy-diagnostics" onclick="OnlineRealm.copyDiagnostics()"></button><textarea id="online-diagnostics-copy" rows="6" readonly hidden style="width:100%;margin-top:8px"></textarea></details>
      <p class="ol-muted" id="online-save-note"></p>
    </section>`;
    const s = ensureState(); field("input-online-alias").value = s.alias; field("input-online-guild").value = s.guildTag; field("input-cf-worker-url").value = s.workerUrl;
  }

  function renderBattle() {
    const element = field("online-battle-card"); if (!element) return;
    const b = runtime.battle; element.hidden = !b;
    if (!b) { runtime.battleRenderKey = ""; return; }
    const countdown = b.deadline ? Math.max(0, Math.ceil((b.deadline - Date.now() - runtime.clockOffset) / 1000)) : 0;
    const battleRenderKey = JSON.stringify([b, zh(), runtime.lastResult, runtime.pending?.kind]);
    if (runtime.battleRenderKey === battleRenderKey) { text("online-round-countdown", countdown); return; }
    runtime.battleRenderKey = battleRenderKey;
    const selectedTarget = field("online-battle-target")?.value;
    const own = b.members.find(m => m.id === runtime.sessionId);
    const health = m => `<div class="ol-person">${esc(m.alias || tr(m.name, m.nameZh))}${m.id === runtime.sessionId ? tr(" (you)", "（你）") : ""}${b.kind === "arena" && m.id ? ` · ${tr("Team", "队伍")} ${m.team + 1}` : ""} — ${m.hp}/${m.maxHp} HP${m.acted ? " ✓" : ""}${m.disconnected ? tr(" · left", " · 已离开") : ""}<div class="ol-health"><span style="width:${Math.max(0, Math.min(100, m.hp / Math.max(1, m.maxHp) * 100))}%"></span></div></div>`;
    const enemies = b.members.filter(m => m.team !== own?.team && m.hp > 0);
    const title = b.kind === "raid" ? tr("Co-op Rift Expedition", "裂隙协作副本") : b.mode === "team" ? tr("3v3 Arena", "3v3 竞技场") : tr("Duel", "双人决斗");
    const active = b.status === "active", canAct = active && !runtime.pending && own?.hp > 0 && !own.acted;
    const intentions = { focus: tr("Focused crush — guard if you draw its attention", "集中重击：承受集火时防御"), cleave: tr("Cleave — every hero will be hit", "横扫：攻击所有队员"), recover: tr("Recover — a chance to strike or heal", "恢复：适合抢攻或治疗") };
    element.innerHTML = `<div class="ol-row" style="justify-content:space-between"><h3>${esc(title)} · ${tr("Round", "回合")} ${b.round}</h3><button onclick="OnlineRealm.leaveBattle()">${b.status === "finished" ? tr("Close result", "关闭结果") : tr("Leave / forfeit", "离开 / 弃权")}</button></div>
      ${b.status === "settling" ? `<p role="status">${tr("Saving the battle result. Your reward receipt is being recorded…", "正在保存战斗结算与奖励收据，请稍候……")}</p>` : ""}
      ${b.status === "lobby" ? `<p>${tr(`Party ${b.members.length}/4. At least 2 connected players are needed to begin.`, `队伍 ${b.members.length}/4 人，至少需要 2 人才能开始。`)}</p>${b.leader === runtime.sessionId ? `<button class="ol-primary" onclick="OnlineRealm.startRaid()" ${b.members.length < 2 || runtime.pending ? "disabled" : ""}>${tr("Start expedition", "开启副本")}</button>` : ""}` : ""}
      ${b.boss ? health(b.boss) + `<p class="ol-danger">${esc(intentions[b.boss.intent] || "")}</p>` : ""}
      <div class="ol-grid">${b.members.map(health).join("")}</div>
      ${active ? `<p class="ol-muted">${tr("One action per round. Auto-guard in", "每回合一次行动。自动防御倒计时")} <span id="online-round-countdown">${countdown}</span>s</p>
      ${b.kind === "arena" ? `<label for="online-battle-target">${tr("Opponent", "攻击目标")}</label><select id="online-battle-target">${enemies.map(m => `<option value="${esc(m.id)}" ${m.id === selectedTarget ? "selected" : ""}>${esc(m.alias)} (${m.hp} HP)</option>`).join("")}</select>` : ""}
      <div class="ol-row" style="margin-top:8px"><button onclick="OnlineRealm.act('attack')" ${canAct ? "" : "disabled"}>${tr("Strike", "攻击")}</button><button onclick="OnlineRealm.act('skill')" ${canAct && own.skillCd === 0 ? "" : "disabled"}>${tr("Class skill", "职业技能")} ${own?.skillCd ? `(${own.skillCd})` : ""}</button><button onclick="OnlineRealm.act('guard')" ${canAct ? "" : "disabled"}>${tr("Guard", "防御")}</button><button onclick="OnlineRealm.act('heal')" ${canAct && own.heals > 0 ? "" : "disabled"}>${tr("Rally self", "自我治疗")} (${own?.heals ?? 0})</button></div>` : ""}
      ${b.status === "finished" ? `<p>${esc(tr("Battle finished. The result is recorded; pending rewards can be recovered after reconnecting.", "战斗已结束，结算已记录；尚未领取的奖励可在重连后补领。"))}</p>` : ""}
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
    const pendingLabels = { joining: tr("Joining party…", "正在加入队伍……"), queueing: tr("Entering queue…", "正在加入匹配……"), starting: tr("Starting expedition…", "正在开启副本……"), leaving: tr("Leaving expedition…", "正在退出……") };
    const statusLabel = runtime.pending ? pendingLabels[runtime.pending.kind] : labels[runtime.status] || labels.offline;
    text("online-status-dot", statusLabel);
    if (!field("online-live-ui")) return;
    text("online-live-title", tr("Companions & Live Expeditions", "伙伴与联机冒险"));
    text("online-live-intro", tr("Meet real explorers. Read the boss intent, coordinate your turns and earn the outcome together.", "与真实冒险者相遇。观察首领意图、配合回合行动，共同赢得战果。"));
    text("online-alias-label", tr("Online alias", "联机昵称")); text("online-guild-label", tr("Team tag", "队伍标记")); text("online-url-label", tr("Cloudflare Worker WebSocket endpoint", "Cloudflare Worker WebSocket 地址"));
    text("online-transport-help", tr("Empty endpoint = chat between tabs of this browser only. A deployed Worker enables cross-device play.", "地址留空：仅同一浏览器标签页聊天。部署 Worker 后可跨设备联机。"));
    text("btn-toggle-online-mode", ["live", "tabs", "connecting"].includes(runtime.status) ? tr("Disconnect", "断开连接") : tr("Connect", "连接"));
    text("btn-sync-character-passport", tr("Sync character", "同步角色")); text("online-transport-badge", statusLabel); text("online-glory", `${tr("Glory", "荣耀")}: ${s.gloryPoints}`); text("online-live-error", runtime.error || "");
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
    const q = field("online-queue-info"); if (q) q.innerHTML = runtime.pending ? `<p role="status">${esc(pendingLabels[runtime.pending.kind])}</p><button onclick="OnlineRealm.cancelPending()">${tr("Cancel and disconnect", "取消并断开")}</button>` : runtime.queue ? `<p>${tr("Matchmaking", "匹配中")} ${runtime.queue.count}/${runtime.queue.need} · ${runtime.queue.mode === "team" ? "3v3" : "1v1"}</p><button onclick="OnlineRealm.leaveQueue()">${tr("Leave queue", "退出匹配")}</button>` : "";
    for (const id of ["btn-online-coop-raid", "btn-online-duel", "btn-online-team-pvp"]) if (field(id)) field(id).disabled = runtime.status !== "live" || isBusy();
    const info = runtime.receiptInfo;
    text("online-reward-title", tr("Battle rewards", "战斗奖励"));
    text("online-reward-status", runtime.receiptMessage || (info?.pending ? tr(`${info.pending} recorded result(s) await local confirmation. Keep this saved hero open to recover them.`, `${info.pending} 份结算正在等待本地存档确认，保持此英雄页面开启即可补领。`) : tr("Recorded results survive reconnects and server restarts. Your recovery identity travels with this hero's JSON save.", "已记录的结算可跨重连和服务器重启补领。恢复身份随此英雄的 JSON 存档保留。")));
    text("online-retry-rewards", tr("Collect pending rewards", "领取待收奖励")); if (field("online-retry-rewards")) field("online-retry-rewards").disabled = runtime.status !== "live";
    text("online-diagnostics-title", tr("Connection and build details", "连接与版本诊断"));
    const last = runtime.lastServerSeen ? new Date(runtime.lastServerSeen).toISOString() : tr("none yet", "尚无");
    const sb = runtime.serverBuild;
    text("online-diagnostics", tr(`Client ${build.version} / ${build.id} (protocol ${PROTOCOL}) · Server ${sb ? `${sb.version} / ${sb.id}` : "unknown"} (protocol ${runtime.serverProtocol ?? "?"}) · ${statusLabel} · Last message ${last}`, `前端 ${build.version} / ${build.id}（协议 ${PROTOCOL}）· 服务端 ${sb ? `${sb.version} / ${sb.id}` : "未知"}（协议 ${runtime.serverProtocol ?? "?"}）· ${statusLabel} · 最近通信 ${last}`));
    text("online-copy-diagnostics", tr("Copy diagnostics", "复制诊断信息"));
    renderBattle();
  }

  function diagnostics() {
    let endpoint = "";
    try { const url = new URL(runtime.endpoint); endpoint = url.origin + url.pathname + "?realm=" + encodeURIComponent(url.searchParams.get("realm") || "global-shard-1"); } catch {}
    return { client: { ...build, protocol: PROTOCOL }, server: runtime.serverBuild, serverProtocol: runtime.serverProtocol,
      connection: runtime.status, pendingAction: runtime.pending?.kind || null, endpoint, closeCode: runtime.closeCode,
      lastCommunication: runtime.lastServerSeen ? new Date(runtime.lastServerSeen).toISOString() : null,
      pendingRewards: runtime.receiptInfo?.pending ?? null };
  }
  async function copyDiagnostics() {
    const value = JSON.stringify(diagnostics(), null, 2);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Manual copy required");
      await navigator.clipboard.writeText(value);
      showToast(tr("Diagnostics copied", "诊断信息已复制"), tr("Recovery tokens are excluded.", "不包含恢复凭证。"), "border-sky-500");
    } catch {
      const area = field("online-diagnostics-copy"); if (area) { area.hidden = false; area.value = value; area.focus(); area.select(); }
    }
    return value;
  }

  function open() {
    mount(); const s = ensureState();
    if (field("input-online-alias")) field("input-online-alias").value = s.alias;
    if (field("input-online-guild")) field("input-online-guild").value = s.guildTag;
    if (field("input-cf-worker-url")) field("input-cf-worker-url").value = s.workerUrl;
    render(); openModal("online-modal");
  }
  if (typeof window !== "undefined") window.addEventListener("beforeunload", () => disconnect(true));
  return { ensureState, passport, connect, disconnect, open, render, sync, chat, joinRaid, startRaid, queue, leaveQueue, leaveBattle, act, isBusy, cancelPending, retryRewards, diagnostics, copyDiagnostics,
    getStatus: () => ({ status: runtime.status, sessionId: runtime.sessionId, playerCount: runtime.players.length, battleId: runtime.battle?.id || null, pending: runtime.pending?.kind || null, receipts: runtime.receiptInfo, lastServerSeen: runtime.lastServerSeen }) };
})();

function ensureOnlineState() { return OnlineRealm.ensureState(); }
function openOnlineModal() { OnlineRealm.open(); }
function toggleOnlineMultiplayer() { OnlineRealm.connect(); }
function syncCharacterToOnline() { OnlineRealm.sync(true); }
function startOnlineCoopRaid() { OnlineRealm.open(); OnlineRealm.joinRaid(); }
function startOnlineTeamSkirmish() { OnlineRealm.open(); OnlineRealm.queue("team"); }
function sendOnlineChatMessage(event) { OnlineRealm.chat(event); }
function renderOnlineHubUI() { OnlineRealm.render(); }
