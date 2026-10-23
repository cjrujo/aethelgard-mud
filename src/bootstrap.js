/* Application integration: durable saves, migration, startup and player guidance. */
const AethelgardApp = (() => {
  const base = { rooms: JSON.parse(JSON.stringify(WORLD_ROOMS)), mobs: JSON.parse(JSON.stringify(MOB_TEMPLATES)),
    items: JSON.parse(JSON.stringify(ITEM_CATALOG)) };
  const originalRender = renderAll, originalLanguage = setLanguage, originalCharacter = applyCharacterConfig;
  let mountedLanguage = '', savingTimer = null, lastSaveOk = true, protectUnreadableSave = false;
  const text = (en, zh) => getLang() === 'zh' ? zh : en;
  const clone = value => JSON.parse(JSON.stringify(value));
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const bounded = (value, fallback, min = 0, max = 1e9) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;

  function clean(value, depth = 0) {
    if (depth > 24) throw new Error('Save data is nested too deeply.');
    if (Array.isArray(value)) return value.slice(0, 5000).map(v => clean(v, depth + 1));
    if (record(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => !['__proto__', 'prototype', 'constructor'].includes(k)).slice(0, 5000).map(([k, v]) => [k, clean(v, depth + 1)]));
    if (typeof value === 'string') return value.slice(0, 20000);
    return value;
  }
  function merge(defaults, value) {
    if (Array.isArray(defaults)) return Array.isArray(value) ? value : clone(defaults);
    if (record(defaults)) {
      const result = record(value) ? { ...value } : {};
      for (const [k, v] of Object.entries(defaults)) result[k] = merge(v, result[k]);
      return result;
    }
    return value === undefined || (defaults !== null && typeof value !== typeof defaults) ? defaults : value;
  }
  function normalizeSave(raw) {
    if (!record(raw) || !record(raw.player) || !record(raw.world)) throw new Error('This is not an Aethelgard save.');
    const result = merge(createInitialState(), clean(raw));
    const p = result.player;
    p.name = String(p.name || 'Kaelen').slice(0, 40);
    if (!Object.hasOwn(CLASS_CONFIG, p.classId)) throw new Error('Unknown hero class.');
    for (const key of ['gold', 'shards', 'rep', 'xp', 'statPoints', 'talentPoints']) p[key] = bounded(p[key], 0);
    p.level = Math.floor(bounded(p.level, 1, 1, 1000));
    p.xpNext = bounded(p.xpNext, 100, 1);
    p.refineLevel = Math.floor(bounded(p.refineLevel, 0, 0, 12));
    for (const key of ['str', 'int', 'agi', 'vit']) p.stats[key] = bounded(p.stats[key], CLASS_CONFIG[p.classId].baseStats[key], 1, 50000);
    for (const key of ['hp', 'mp', 'sta']) p[key] = bounded(p[key], 0);
    for (const key of ['warlord', 'mystic', 'pathfinder']) p.talents[key] = Math.floor(bounded(p.talents[key], 0, 0, 5));
    p.cooldowns = [0, 1, 2].map(i => Math.floor(bounded(p.cooldowns[i], 0, 0, 100)));
    p.buffs = p.buffs.filter(value => ['Guard', 'ArcaneShield', 'EvasionVeil'].includes(value));
    p.buffTurns = record(p.buffTurns) ? Object.fromEntries(Object.entries(p.buffTurns).filter(([key]) => p.buffs.includes(key)).map(([key, value]) => [key, Math.floor(bounded(value, 0, 0, 100))])) : {};
    p.inventory = Object.fromEntries(Object.entries(p.inventory).filter(([k, q]) => typeof k === 'string' && Number.isFinite(q) && q > 0).map(([k, q]) => [k, Math.min(1e6, Math.floor(q))]));
    if (!['balanced', 'aggressive', 'defensive'].includes(p.stance)) p.stance = 'balanced';
    if (!UI_I18N[result.lang]) result.lang = 'en';
    if (!['normal', 'fast', 'paused'].includes(result.tickSpeed)) result.tickSpeed = 'normal';
    result.tickCount = Math.floor(bounded(result.tickCount, 1, 1));
    result.mapZoom = bounded(result.mapZoom, 1, .45, 2.5);
    result.autoHunt = false; // Loading never silently resumes unattended attacks.
    result.logs = result.logs.filter(record).slice(-140);
    result.aiLogs = result.aiLogs.filter(record).slice(-30);
    for (const entry of result.aiLogs) if (entry.status === 'generating') {
      entry.status = 'cancelled'; entry.error = result.lang === 'zh' ? '恢复存档时已结束旧请求，请重新提问。' : 'Previous request ended when this save was restored. Please ask again.';
    }
    result.quests.completed = [...new Set(result.quests.completed.filter(id => STORY_QUESTS.some(q => q.id === id)))];
    result.quests.bounties = result.quests.bounties.filter(b => record(b) && typeof b.id === 'string').slice(0, 10);
    result.world.visitedRooms = [...new Set(result.world.visitedRooms.filter(id => typeof id === 'string'))];
    result.world.defeatedBosses = [...new Set(result.world.defeatedBosses.filter(id => typeof id === 'string'))];
    result.world.proceduralRooms = Array.isArray(result.world.proceduralRooms) ? result.world.proceduralRooms.filter(r => record(r) && /^r_frontier_\w+$/.test(r.id) && record(r.exits)).slice(0, 1000) : [];
    for (const key of ['proceduralMobs', 'proceduralItems']) if (!record(result.world[key])) result.world[key] = {};
    // These extensions were optional in older saves. Normalize them before any
    // current state is replaced: malformed companions or journal entries used
    // to throw during rendering after the damaged save had already been applied.
    const fun = record(result.fun) ? result.fun : {};
    result.fun = {
      companionIdx: Math.floor(bounded(fun.companionIdx, 0, 0, COMPANION_ROSTER.length - 1)),
      companionLevel: Math.floor(bounded(fun.companionLevel, 1, 1)),
      overdrive: bounded(fun.overdrive, 50, 0, 100),
      comboCount: Math.floor(bounded(fun.comboCount, 0, 0, 8)),
      chestsOpened: Math.floor(bounded(fun.chestsOpened, 0))
    };
    if (!record(result.director)) result.director = {};
    result.director.journal = Array.isArray(result.director.journal) ? result.director.journal.filter(record).slice(-100) : [];
    if (!record(result.combatLedger)) result.combatLedger = {};
    for (const key of ['claimed', 'bossRespawn']) if (!record(result.combatLedger[key])) result.combatLedger[key] = {};
    if (!result.combat.enemy || !record(result.combat.enemy) || !(result.combat.enemy.hp > 0)) result.combat = { inCombat: false, enemy: null };
    result.version = 'v10'; result.saveSchema = 10;
    return result;
  }
  function resetCatalogs() {
    for (const [target, source] of [[WORLD_ROOMS, base.rooms], [MOB_TEMPLATES, base.mobs], [ITEM_CATALOG, base.items]]) {
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, clone(source));
    }
  }
  function stopLiveActivity() {
    if (autoWalkHandle) { clearInterval(autoWalkHandle); autoWalkHandle = null; }
    AethelgardAI.resetSession(); OnlineRealm.disconnect(true); GameDirector.close();
  }
  function restore(value) {
    // Validate completely before changing the current hero.
    const next = normalizeSave(value);
    protectUnreadableSave = false;
    stopLiveActivity(); resetCatalogs(); state = next; restoreProceduralWorld();
    if (!WORLD_ROOMS[state.world.currentRoom]) state.world.currentRoom = 'r_town_square';
    state.world.visitedRooms = state.world.visitedRooms.filter(id => WORLD_ROOMS[id]);
    if (!state.world.visitedRooms.includes(state.world.currentRoom)) state.world.visitedRooms.push(state.world.currentRoom);
    for (const slot of Object.keys(state.player.equipment)) if (state.player.equipment[slot] && !ITEM_CATALOG[state.player.equipment[slot]]) state.player.equipment[slot] = null;
    selectedClassOption = state.player.classId;
    GameDirector.ensureState(); CombatDirector.ensure(); AethelgardAI.ensureState(); OnlineRealm.ensureState();
    computeDerivedStats();
    mountedLanguage = ''; renderAll(); startHeartbeat();
    return true;
  }
  function save(notify = true) {
    if (protectUnreadableSave) {
      lastSaveOk = false;
      if (notify) showToast(text('Original save preserved', '已保留原始存档'), text('Create a new chronicle or import a valid save before replacing it.', '请明确创建新旅程或导入有效存档后再替换。'), 'border-amber-500');
      return false;
    }
    state.version = 'v10'; state.saveSchema = 10; state.savedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); lastSaveOk = true;
      if (notify) showToast(text('Game saved', '进度已保存'), text('Your journey is stored in this browser.', '旅程已保存在当前浏览器。'), 'border-emerald-500');
      return true;
    } catch (error) {
      lastSaveOk = false;
      if (notify) showToast(text('Export your save', '请导出存档'), text('Browser storage is unavailable or full. Use Save / JSON.', '浏览器存储不可用或空间不足，请使用“存档 / JSON”。'), 'border-amber-500');
      const note = document.getElementById('app-save-status');
      if (note) note.textContent = text('Auto-save unavailable · export your JSON save.', '自动存档不可用，请导出 JSON 存档。');
      return false;
    }
  }
  function load(notify = true) {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { if (notify) showToast(text('No save yet', '尚无存档'), '', 'border-sky-500'); return false; }
      restore(JSON.parse(raw));
      if (notify) showToast(text('Journey restored', '旅程已恢复'), state.player.name, 'border-sky-500');
      return true;
    } catch (error) {
      // An automatic fresh start must never silently overwrite an unreadable save.
      if (raw !== null) {
        try { localStorage.setItem(STORAGE_KEY + '_unreadable_' + Date.now(), raw); }
        catch (_) { protectUnreadableSave = true; lastSaveOk = false; }
      }
      addLog('The previous save could not be loaded. Its original data has been preserved for recovery.', 'world', 'text-amber-300', '旧存档无法读取，原始数据已保留以便恢复。');
      if (notify) showToast(text('Save could not be loaded', '无法读取存档'), String(error.message), 'border-rose-500');
      return false;
    }
  }
  function importSave() {
    const field = document.getElementById('save-json-textarea'); if (!field?.value.trim()) return;
    try {
      if (field.value.length > 10 * 1024 * 1024) throw new Error('Save JSON exceeds 10 MB.');
      restore(JSON.parse(field.value)); save(false); closeModal('save-modal');
      showToast(text('Save imported', '存档已导入'), state.player.name, 'border-emerald-500');
    } catch (error) { showToast(text('Invalid save', '存档无效'), String(error.message), 'border-rose-500'); }
  }
  function newGame() {
    // The explicit New Chronicle button is the player's authorization to replace it.
    try { localStorage.setItem(STORAGE_KEY + '_previous', JSON.stringify(state)); } catch (_) {}
    const language = getLang(); const fresh = createInitialState(); fresh.lang = language;
    restore(fresh); closeModal('char-modal'); save(false);
    addLog('A new chronicle begins. Your previous hero is retained as a backup.', 'world', 'text-amber-300', '新的编年史开始了。上一位英雄已保留为备份。');
    GameDirector.startEncounter('first_oath');
  }
  function restorePrevious() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY + '_previous');
      if (!raw) throw new Error(text('No previous hero backup.', '没有上一位英雄的备份。'));
      restore(JSON.parse(raw)); save(false); closeModal('save-modal');
    } catch (error) { showToast(text('Backup unavailable', '备份不可用'), error.message, 'border-amber-500'); }
  }
  function mountGuide() {
    const modal = document.getElementById('help-modal'); if (!modal) return;
    const rows = [
      ['Your first journey', '开始冒险', 'Open Journey → Story here. Follow the next objective, investigate landmarks, and watch how choices change faction trust. Chapters lead toward three possible endings.', '打开“任务 → 此地故事”。跟随下一步目标，调查地标，留意选择如何改变各阵营的信任。不同经历将通往三种结局。'],
      ['Every turn is a decision', '每回合都由你决定', 'Read the enemy intent. Guard a heavy blow, interrupt a charge or spell (18 STA), then exploit an exposed enemy. Drinking a potion also uses a turn. Auto-hunt continuously starts new encounters here after victories. Toggle it off to stop automatic actions; any current battle remains manual. It stops on retreat or defeat, and pauses at low health if stamina is insufficient to retreat or before starting another battle.', '先看敌人意图：重击时防御；蓄力或吟唱时打断（18体力）；敌人露出破绽时输出。喝药也占用一个回合。自动狩猎会在获胜后连续挑战此地敌人；再次关闭可停止自动操作，当前战斗交回手动。撤退或战败会关闭；低血量且无法撤退时，或低血量准备开始下一场时，会自动暂停。'],
      ['Prepare before danger', '出发前做好准备', 'Rest fully in a safe settlement. Trade and brew at settlements; forge or refine at a smithy. New companions unlock through exploration, crafting and a boss victory. Lost gold can be recovered at your defeat location.', '安全据点可以完全休息、交易和炼药；锻造或精炼需要铁匠铺。探索、合成和击败首领可以解锁伙伴。战败遗失的钱袋可返回原地取回。'],
      ['Local AI DM', '本地 AI 智脑', 'AI DM → Browser CPU → choose a model → Download / load. Qwen supports Chinese and English; SmolLM2 is a lighter English model. No API key is required. First download needs internet; cached or prepared model packages can run offline.', '智脑 → 浏览器 CPU → 选择模型 → 下载并加载。Qwen 支持中文和英文；SmolLM2 是更轻量的英文模型。无需 API Key。首次下载需要网络；缓存或准备好的模型包可离线运行。'],
      ['Ollama alternative', '使用本机 Ollama', 'Start this game with the local launcher. Run ollama pull qwen2.5:0.5b, select Ollama, then Connect / check models. Keep the local Ollama service running.', '用本地启动器打开游戏，执行 ollama pull qwen2.5:0.5b。选择 Ollama 并点击“连接并检测模型”，保持本机 Ollama 服务运行。'],
      ['Multiplayer', '与真实玩家联机', 'Internet raids and 1v1 / 3v3 arenas require the v10 Worker endpoint. An empty endpoint only connects tabs in the same browser. Rewards require a completed battle and participation.', '互联网合作副本与 1v1 / 3v3 竞技场需要 v10 Worker 地址。地址留空时只连接同一浏览器的标签页。完成战斗并实际参与才会获得奖励。'],
      ['Keep your chronicle', '保存你的旅程', 'Progress auto-saves in this browser. Export JSON before changing devices. Imported v9 saves are migrated; new characters keep one previous-hero backup.', '进度会自动保存至当前浏览器。更换设备前请导出 JSON。v9 存档会自动迁移；创建新角色时保留一份上一位英雄的备份。']
    ];
    modal.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="guide-title" class="bg-slate-950 border border-slate-700 rounded-2xl max-w-2xl w-full p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto"><div class="flex justify-between gap-3"><h2 id="guide-title" class="text-xl text-amber-300 font-bold">${text('A traveler’s guide', '旅人指南')}</h2><button class="ai-control" onclick="closeModal('help-modal')" aria-label="${text('Close', '关闭')}">✕</button></div>${rows.map(([en,zh,body,bodyZh])=>`<article class="border-b border-slate-800 pb-3"><h3 class="font-bold text-sky-200 mb-1">${text(en,zh)}</h3><p class="text-sm leading-relaxed text-slate-300">${text(body,bodyZh)}</p></article>`).join('')}<div class="text-sm text-emerald-200 leading-loose"><code>n / s / e / w / u / d · look · harvest · rest · attack · skill 1 · guard · interrupt · flee · recover · journal · encounter · choose 1 · ai [question] · save · load</code></div><p class="text-xs text-slate-400">${text('New story and model controls are fully localized in English and Simplified Chinese. Other legacy UI languages remain available with English fallback for new content.', '新增故事与模型控制完整支持简体中文、英文。其他旧版界面语言继续保留，新增内容回退为英文。')}</p></section>`;
  }
  function renderIntegration() {
    if (mountedLanguage !== getLang()) {
      mountedLanguage = getLang(); AethelgardAI.mount(); mountGuide();
      document.documentElement.lang = getLang(); document.documentElement.dir = getLang() === 'ar' ? 'rtl' : 'ltr';
    }
    AethelgardAI.render();
    switchRightTab(['inventory', 'crafting', 'quests', 'achievements', 'ai'].includes(state.rightTab) ? state.rightTab : 'quests');
    const saveModal = document.getElementById('save-modal');
    if (saveModal && !document.getElementById('app-save-status')) {
      const box = saveModal.querySelector('textarea')?.parentElement;
      if (box) box.insertAdjacentHTML('beforeend', '<p id="app-save-status" class="text-xs text-slate-400"></p><button id="app-restore-previous" class="ai-control" onclick="AethelgardApp.restorePrevious()"></button>');
    }
    const status = document.getElementById('app-save-status');
    if (status) status.textContent = lastSaveOk ? text('Auto-save is on. Export JSON to move between devices.', '自动存档已开启。跨设备请导出 JSON。') : text('Storage unavailable. Export JSON now.', '存储不可用，请导出 JSON。');
    const previous = document.getElementById('app-restore-previous'); if (previous) previous.textContent = text('Restore previous hero backup', '恢复上一位英雄备份');
    const heroInput = document.getElementById('input-hero-name');
    if (heroInput && document.activeElement !== heroInput) heroInput.value = state.player.name;
  }
  function scheduleSave() {
    if (savingTimer !== null) return;
    savingTimer = setTimeout(() => { savingTimer = null; save(false); }, 10000);
  }

  saveGameState = save; loadGameState = load; importSaveJson = importSave; resetNewGame = newGame;
  renderAll = function() { originalRender(); renderIntegration(); scheduleSave(); };
  setLanguage = function(code) { originalLanguage(code); renderIntegration(); };
  applyCharacterConfig = function() {
    if (OnlineRealm.isBusy()) return showToast(text('Finish the online battle first', '请先结束在线战斗'), '', 'border-amber-500');
    const oldClass = state.player.classId, oldName = state.player.name;
    const result = originalCharacter();
    if (oldClass !== state.player.classId || oldName !== state.player.name) OnlineRealm.disconnect(true);
    return result;
  };
  window.onload = function() {
    const loaded = load(false);
    if (!loaded) {
      if (navigator.language?.toLowerCase().startsWith('zh')) state.lang = 'zh';
      GameDirector.ensureState(); CombatDirector.ensure(); AethelgardAI.ensureState(); OnlineRealm.ensureState();
      addLog('Welcome to Aethelgard: Living Chronicles. Your first choice awaits beside the well.', 'world', 'text-amber-300', '欢迎来到艾瑟尔加德：活世界编年史。复苏之井旁，等待着你的第一个选择。');
      describeCurrentRoom();
    }
    renderAll(); startHeartbeat();
    if ('serviceWorker' in navigator && ['http:', 'https:'].includes(location.protocol)) {
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(error => {
        console.info('Offline cache unavailable on this origin:', error.message);
      });
    }
  };
  window.addEventListener('beforeunload', () => save(false));
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(false); });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || GameDirector.isModalOpen()) return;
    for (const id of ['help-modal', 'save-modal', 'char-modal', 'online-modal']) closeModal(id);
  });
  return { normalizeSave, restore, restorePrevious, getSaveStatus: () => ({ ok: lastSaveOk, savedAt: state.savedAt }) };
})();
window.AethelgardApp = AethelgardApp;
