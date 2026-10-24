/* Application integration: durable saves, migration, startup and player guidance. */
const AethelgardApp = (() => {
  const base = { rooms: JSON.parse(JSON.stringify(WORLD_ROOMS)), mobs: JSON.parse(JSON.stringify(MOB_TEMPLATES)),
    items: JSON.parse(JSON.stringify(ITEM_CATALOG)), titles: JSON.parse(JSON.stringify(ROOM_TITLE_I18N)) };
  const originalRender = renderAll, originalLanguage = setLanguage, originalCharacter = applyCharacterConfig;
  let mountedLanguage = '', savingTimer = null, lastSaveOk = true, protectUnreadableSave = false;
  const text = (en, zh) => getLang() === 'zh' ? zh : en;
  const clone = value => JSON.parse(JSON.stringify(value));
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const bounded = (value, fallback, min = 0, max = 1e9) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  const tabId = crypto.randomUUID(), writerKey = STORAGE_KEY + '_writer', requestKey = STORAGE_KEY + '_writer_request';
  const webLocks = Boolean(navigator.locks?.request), leaseMs = 20000;
  let ownership = 'unclaimed', ownershipReason = '', expectedRaw, releaseLock = null, acquisition = null;
  let conflictKey = null, latestBuild = null, registration = null, refreshRequested = false, booted = false;
  const build = window.AETHELGARD_BUILD || { version: '11.0.0', id: 'development', protocol: 11 };

  function disk() { return localStorage.getItem(STORAGE_KEY); }
  function lease() {
    try { return JSON.parse(localStorage.getItem(writerKey) || 'null'); } catch (_) { return null; }
  }
  function checkpoint(key, value = state) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error(text('Backup could not be verified.', '无法确认备份已写入。'));
    return key;
  }
  function rememberConflict() {
    try { conflictKey = checkpoint(STORAGE_KEY + '_conflict_' + tabId); return true; }
    catch (_) { lastSaveOk = false; return false; }
  }
  function stopBackgroundPlay() {
    state.autoHunt = false;
    if (tickIntervalHandle !== null) { clearInterval(tickIntervalHandle); tickIntervalHandle = null; }
    if (savingTimer !== null) { clearTimeout(savingTimer); savingTimer = null; }
    if (autoWalkHandle) { clearInterval(autoWalkHandle); autoWalkHandle = null; }
    AethelgardAI.resetSession(); OnlineRealm.disconnect(true);
  }
  function observe(reason, preserve = false) {
    const wasWriter = ownership === 'writer';
    ownership = 'observer'; ownershipReason = reason; lastSaveOk = false;
    if (preserve && wasWriter) rememberConflict();
    if (wasWriter || booted) stopBackgroundPlay();
    if (releaseLock) { const release = releaseLock; releaseLock = null; release(); }
    renderOwnership();
    return false;
  }
  function renewLease() {
    localStorage.setItem(writerKey, JSON.stringify({ tabId, expires: Date.now() + leaseMs, version: build.version }));
  }
  function claimFallback(force = false) {
    try {
      const current = lease();
      if (!force && current && current.tabId !== tabId && current.expires > Date.now()) return observe('other-tab');
      const raw = disk();
      if (expectedRaw === undefined) expectedRaw = raw;
      else if (raw !== expectedRaw && !force) return observe('conflict', true);
      renewLease();
      ownership = 'writer'; ownershipReason = ''; renderOwnership();
      return true;
    } catch (_) { return observe('storage'); }
  }
  function canWrite() {
    if (ownership === 'unclaimed' && !webLocks) claimFallback();
    if (ownership !== 'writer') return false;
    try {
      if (lease()?.tabId !== tabId) return observe('other-tab', true);
      if (disk() !== expectedRaw) return observe('conflict', true);
      return true;
    } catch (_) { return observe('storage', true); }
  }
  function acquireWriter(wait = false) {
    if (!webLocks) return Promise.resolve(claimFallback(wait));
    if (acquisition) return acquisition;
    let finish;
    const settled = new Promise(resolve => { finish = resolve; });
    acquisition = settled;
    const controller = new AbortController();
    const timeout = wait ? setTimeout(() => controller.abort(), 3000) : null;
    navigator.locks.request('aethelgard-hero-writer', wait ? { signal: controller.signal } : { ifAvailable: true }, async lock => {
      if (timeout !== null) clearTimeout(timeout);
      if (!lock) { observe('other-tab'); finish(false); return; }
      try {
        // The previous owner may have saved while this tab waited for the lock.
        const raw = disk(); expectedRaw = raw;
        ownership = 'writer'; ownershipReason = ''; renewLease();
        if (raw) { try { restore(JSON.parse(raw)); } catch (_) { load(false); } }
        renderOwnership();
        if (booted) startHeartbeat();
        finish(true);
        await new Promise(resolve => { releaseLock = resolve; });
      } catch (error) { observe('storage'); finish(false); }
    }).catch(error => { if (timeout !== null) clearTimeout(timeout); observe(error.name === 'AbortError' ? 'other-tab' : 'storage'); finish(false); });
    settled.finally(() => { if (acquisition === settled) acquisition = null; });
    return settled;
  }
  function relinquish({ handoff = false } = {}) {
    if (ownership === 'writer' && !save(false)) {
      // A requested handoff must never replace unsaved play with an older disk
      // snapshot. Keep ownership until the player can save or export this page.
      rememberConflict();
      if (handoff && ownership === 'writer') {
        showToast(text('Takeover paused', '接管已暂停'), text('This hero could not be saved. Keep this page open and export its progress first.', '此英雄尚未保存成功。请保持本页打开，先导出进度。'), 'border-amber-500');
        return false;
      }
    }
    try { if (lease()?.tabId === tabId) localStorage.removeItem(writerKey); } catch (_) {}
    observe('other-tab');
    return true;
  }
  function waitForLeaseRelease() {
    const available = () => { const current = lease(); return !current || current.tabId === tabId || current.expires <= Date.now(); };
    if (available()) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer;
      const finish = result => { clearTimeout(timer); window.removeEventListener('storage', changed); resolve(result); };
      const changed = event => { if ((event.key === writerKey || event.key === null) && available()) finish(true); };
      window.addEventListener('storage', changed);
      timer = setTimeout(() => finish(available()), 3000);
    });
  }
  async function takeOver() {
    if (canWrite()) return true;
    // A conflicted page retains its own unsaved branch before loading the latest.
    if (ownershipReason === 'conflict' && !rememberConflict()) {
      showToast(text('Export this page first', '请先导出本页进度'), text('There is no room for a recovery snapshot.', '无法写入恢复快照，已保留当前页面。'), 'border-amber-500');
      return false;
    }
    try { localStorage.setItem(requestKey, JSON.stringify({ tabId, nonce: crypto.randomUUID() })); }
    catch (_) { observe('storage'); return false; }
    if (webLocks) {
      const acquired = await acquireWriter(true);
      if (!acquired) showToast(text('Takeover not completed', '接管尚未完成'), text('The other page is still active. Check that its latest progress can be saved or exported.', '另一页面仍在使用此英雄，请检查该页能否保存或导出最新进度。'), 'border-amber-500');
      return acquired;
    }
    if (!await waitForLeaseRelease()) {
      showToast(text('Takeover not completed', '接管尚未完成'), text('Save or export the active page before trying again.', '请先在正在使用的页面保存或导出进度，再重试。'), 'border-amber-500');
      return false;
    }
    const raw = disk();
    expectedRaw = raw;
    if (!claimFallback()) return false;
    if (raw) { try { restore(JSON.parse(raw)); } catch (_) { load(false); } }
    if (booted) startHeartbeat(); renderOwnership();
    return true;
  }
  function renderOwnership() {
    const main = document.getElementById('main-viewport-grid');
    if (main) main.inert = ownership !== 'writer';
    const banner = document.getElementById('app-save-banner');
    if (banner) banner.hidden = ownership === 'writer';
    const message = document.getElementById('app-save-banner-text');
    if (message) message.textContent = ownershipReason === 'conflict' ? text('Another page changed this save. This page is paused; keep or export its recovery snapshot before taking over.', '另一页面已更改存档。本页已暂停；可保留或导出恢复快照，再接管最新进度。') :
      ownershipReason === 'storage' ? text('Browser storage is unavailable. Export your progress before leaving.', '浏览器存储不可用，请在离开前导出进度。') :
      text('This hero is open in another tab. This page is read-only. Take over to load the latest saved progress.', '此英雄已在另一标签页打开，本页只读。接管后会载入最新已保存的进度。');
    const take = document.getElementById('app-take-over'); if (take) take.textContent = text('Take over and load latest', '接管并载入最新进度');
    const exp = document.getElementById('app-export-paused'); if (exp) exp.textContent = text('Export this page', '导出本页进度');
  }

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
    if (record(result.hunt?.session) && result.hunt.session.status === 'running') {
      result.hunt.session.status = 'stopped'; result.hunt.session.stopReason = 'reloaded'; result.hunt.session.stoppedTick = result.tickCount;
    }
    result.logs = result.logs.filter(record).slice(-140);
    result.aiLogs = result.aiLogs.filter(record).slice(-30);
    for (const entry of result.aiLogs) if (entry.status === 'generating') {
      entry.status = 'cancelled'; entry.error = result.lang === 'zh' ? '恢复存档时已结束旧请求，请重新提问。' : 'Previous request ended when this save was restored. Please ask again.';
    }
    result.quests.completed = [...new Set(result.quests.completed.filter(id => STORY_QUESTS.some(q => q.id === id)))];
    result.quests.bounties = result.quests.bounties.filter(b => record(b) && typeof b.id === 'string').slice(0, 10);
    result.world.visitedRooms = [...new Set(result.world.visitedRooms.filter(id => typeof id === 'string'))];
    result.world.defeatedBosses = [...new Set(result.world.defeatedBosses.filter(id => typeof id === 'string'))];
    result.world.proceduralRooms = Array.isArray(result.world.proceduralRooms) ? result.world.proceduralRooms.filter(r => record(r) && /^r_frontier_\w+$/.test(r.id) && record(r.exits)).slice(0, 1000).map(room => {
      for (const field of ['mobs', 'npcs', 'nodes']) {
        if (room[field] === undefined) room[field] = [];
        if (!Array.isArray(room[field])) throw new Error('Invalid frontier room ' + field + ': ' + room.id);
      }
      if (!room.mobs.every(id => typeof id === 'string') || !room.npcs.every(id => typeof id === 'string') ||
          !room.nodes.every(node => record(node) && typeof node.item === 'string') ||
          !Object.entries(room.exits).every(([direction, target]) => ['n', 's', 'e', 'w', 'u', 'd'].includes(direction) && typeof target === 'string')) {
        throw new Error('Invalid frontier room: ' + room.id);
      }
      return room;
    }) : [];
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
    result.version = 'v11'; result.saveSchema = 11;
    result.saveRevision = Math.floor(bounded(result.saveRevision, 0));
    return result;
  }
  function resetCatalogs() {
    for (const [target, source] of [[WORLD_ROOMS, base.rooms], [MOB_TEMPLATES, base.mobs], [ITEM_CATALOG, base.items], [ROOM_TITLE_I18N, base.titles]]) {
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, clone(source));
    }
  }
  function stopLiveActivity() {
    if (autoWalkHandle) { clearInterval(autoWalkHandle); autoWalkHandle = null; }
    AethelgardAI.resetSession(); OnlineRealm.disconnect(true); GameDirector.close();
  }
  function restore(value) {
    const next = normalizeSave(value);
    const previous = clone(state), protectedBefore = protectUnreadableSave;
    const catalogs = [WORLD_ROOMS, MOB_TEMPLATES, ITEM_CATALOG, ROOM_TITLE_I18N].map(target => [target, clone(target)]);
    try {
      protectUnreadableSave = false;
      stopLiveActivity(); resetCatalogs(); state = next; restoreProceduralWorld();
      if (!WORLD_ROOMS[state.world.currentRoom]) state.world.currentRoom = 'r_town_square';
      state.world.visitedRooms = state.world.visitedRooms.filter(id => WORLD_ROOMS[id]);
      if (!state.world.visitedRooms.includes(state.world.currentRoom)) state.world.visitedRooms.push(state.world.currentRoom);
      for (const slot of Object.keys(state.player.equipment)) if (state.player.equipment[slot] && !ITEM_CATALOG[state.player.equipment[slot]]) state.player.equipment[slot] = null;
      selectedClassOption = state.player.classId;
      GameDirector.ensureState(); CombatDirector.ensure(); AethelgardAI.ensureState(); OnlineRealm.ensureState();
      computeDerivedStats();
      mountedLanguage = ''; renderAll(); if (ownership === 'writer') startHeartbeat();
      return true;
    } catch (error) {
      state = previous; protectUnreadableSave = protectedBefore;
      for (const [target, source] of catalogs) {
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, source);
      }
      selectedClassOption = state.player.classId; mountedLanguage = '';
      try { renderAll(); if (ownership === 'writer') startHeartbeat(); } catch (_) {}
      throw error;
    }
  }
  function save(notify = true) {
    if (protectUnreadableSave) {
      lastSaveOk = false;
      if (notify) showToast(text('Original save preserved', '已保留原始存档'), text('Create a new chronicle or import a valid save before replacing it.', '请明确创建新旅程或导入有效存档后再替换。'), 'border-amber-500');
      return false;
    }
    if (!canWrite()) {
      if (notify) showToast(text('This page is paused', '本页已暂停'), text('Take over this hero or export this page.', '请先接管此英雄，或导出本页进度。'), 'border-amber-500');
      return false;
    }
    try {
      const meta = { version: 'v11', saveSchema: 11, saveRevision: (state.saveRevision || 0) + 1,
        savedAt: new Date().toISOString(), saveWriter: tabId };
      const raw = JSON.stringify({ ...state, ...meta });
      localStorage.setItem(STORAGE_KEY, raw);
      if (disk() !== raw) return observe('conflict', true);
      expectedRaw = raw; Object.assign(state, meta); lastSaveOk = true;
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
      expectedRaw = raw;
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
      const next = normalizeSave(JSON.parse(field.value));
      if (!replaceHero(next, STORAGE_KEY + '_previous')) return false;
      closeModal('save-modal');
      showToast(text('Save imported and stored', '存档已导入并保存'), state.player.name, 'border-emerald-500');
      return true;
    } catch (error) { showToast(text('Invalid save', '存档无效'), String(error.message), 'border-rose-500'); return false; }
  }
  function newGame() {
    const language = getLang(); const fresh = createInitialState(); fresh.lang = language;
    if (!replaceHero(fresh, STORAGE_KEY + '_previous')) return false;
    closeModal('char-modal');
    addLog('A new chronicle begins. Your previous hero is retained as a backup.', 'world', 'text-amber-300', '新的编年史开始了。上一位英雄已保留为备份。');
    GameDirector.startEncounter('first_oath');
    return true;
  }
  function replaceHero(value, backupKey) {
    const next = normalizeSave(value);
    if (!canWrite()) { showToast(text('Take over this hero first', '请先接管此英雄'), '', 'border-amber-500'); return false; }
    if (OnlineRealm.isBusy()) { showToast(text('Finish the online battle first', '请先结束在线战斗'), '', 'border-amber-500'); return false; }
    const current = clone(state), protectedBefore = protectUnreadableSave;
    try { checkpoint(backupKey, current); }
    catch (_) { showToast(text('Backup failed; hero kept', '备份失败，已保留当前英雄'), text('Export JSON before trying again.', '请先导出 JSON，再重试。'), 'border-amber-500'); return false; }
    try {
      restore(next);
      if (save(false)) return true;
    } catch (_) { /* A partially restored hero must never become the next autosave. */ }
    try { restore(current); } finally { protectUnreadableSave = protectedBefore; }
    showToast(text('Change was not saved', '变更未保存'), text('Your current hero is retained. Export JSON to keep a copy.', '已保留原英雄，请导出 JSON 保存副本。'), 'border-amber-500');
    return false;
  }
  function restorePrevious() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY + '_previous');
      if (!raw) throw new Error(text('No previous hero backup.', '没有上一位英雄的备份。'));
      if (replaceHero(JSON.parse(raw), STORAGE_KEY + '_before_restore')) { closeModal('save-modal'); return true; }
    } catch (error) { showToast(text('Backup unavailable', '备份不可用'), error.message, 'border-amber-500'); }
    return false;
  }
  function backups() {
    const items = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(STORAGE_KEY + '_') || !/_(previous|before_restore|conflict_|unreadable_)/.test(key.slice(STORAGE_KEY.length))) continue;
        const raw = localStorage.getItem(key); let value;
        try { value = JSON.parse(raw); } catch (_) {}
        items.push({ key, name: value?.player?.name || text('Original unreadable save', '原始损坏存档'), savedAt: value?.savedAt || '', valid: Boolean(value?.player && value?.world) });
      }
    } catch (_) {}
    return items.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  function downloadJson(raw, filename) {
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  function exportCurrent() { return downloadJson(JSON.stringify(state, null, 2), 'aethelgard-hero-backup.json'); }
  function exportBackup() {
    const key = document.getElementById('app-backup-select')?.value;
    if (!backups().some(item => item.key === key)) return false;
    return downloadJson(localStorage.getItem(key), 'aethelgard-recovery-backup.json');
  }
  function restoreBackup() {
    const key = document.getElementById('app-backup-select')?.value;
    if (!backups().some(item => item.key === key && item.valid)) return false;
    try { return replaceHero(JSON.parse(localStorage.getItem(key)), STORAGE_KEY + '_before_restore'); }
    catch (error) { showToast(text('Backup unavailable', '备份不可用'), error.message, 'border-amber-500'); return false; }
  }
  function mountGuide() {
    const modal = document.getElementById('help-modal'); if (!modal) return;
    const rows = [
      ['Your first journey', '开始冒险', 'Follow the next journey step to meet each chapter’s people, investigate, prepare and face its ruler. You can defer a story and return from the journal. Before the ending, inspect unresolved clues and their locations.', '跟随“旅程下一步”，依次认识各章人物、调查线索、做好准备并挑战首领。故事可明确暂缓，之后从日志回访。最终选择前可查看尚未解决的线索与地点。'],
      ['Every turn is a decision', '每回合都由你决定', 'Read enemy intent. Guard heavy blows. Interrupting a charge skips its heavy follow-up and exposes the enemy; interrupting a spell cancels only that cast. Both cost 18 STA. Potions take a turn. Auto-hunt defaults to one encounter. Hunt settings also offer an eligible kill contract or explicitly continuous hunts, with battle and health limits. A stopped encounter remains playable manually.', '先看敌人意图：重击时防御。打断蓄力可跳过后续重击并制造破绽；打断施法只取消本次法术，两者均消耗18体力。喝药也占用一回合。自动狩猎默认只打一场；在狩猎设置中可选择当前击杀契约或连续狩猎，并设定场数与生命下限。停止后的当前战斗可继续手动操作。'],
      ['Prepare before danger', '出发前做好准备', 'Rest fully in a safe settlement. Trade and brew at settlements; forge or refine at a smithy. New companions unlock through exploration, crafting and a boss victory. Lost gold can be recovered at your defeat location.', '安全据点可以完全休息、交易和炼药；锻造或精炼需要铁匠铺。探索、合成和击败首领可以解锁伙伴。战败遗失的钱袋可返回原地取回。'],
      ['Local AI DM', '本地 AI 智脑', 'AI DM → Browser CPU → choose a model → Download / load. Qwen supports Chinese and English; SmolLM2 is a lighter English model. No API key is required. First download needs internet; cached or prepared model packages can run offline.', '智脑 → 浏览器 CPU → 选择模型 → 下载并加载。Qwen 支持中文和英文；SmolLM2 是更轻量的英文模型。无需 API Key。首次下载需要网络；缓存或准备好的模型包可离线运行。'],
      ['Ollama alternative', '使用本机 Ollama', 'Start this game with the local launcher. Run ollama pull qwen2.5:0.5b, select Ollama, then Connect / check models. Keep the local Ollama service running.', '用本地启动器打开游戏，执行 ollama pull qwen2.5:0.5b。选择 Ollama 并点击“连接并检测模型”，保持本机 Ollama 服务运行。'],
      ['Guild and companions', '公会与伙伴', 'Guild services show reputation ranks, trade benefits, gathering preparation, shard equipment exchanges and companion training. Read each price and unlock condition. A companion’s displayed level is its real training level.', '公会服务展示声望等级、交易权益、采集准备、碎片装备兑换与伙伴培养。操作前可查看价格与解锁条件。伙伴显示的等级就是实际培养等级。'],
      ['Multiplayer', '与真实玩家联机', 'Internet raids and arenas require the protocol 11 Worker. Diagnostics show both build versions. Finished rewards are retained by the server until your hero saves and acknowledges them; reconnect with the same hero and realm to recover pending rewards. An empty endpoint enables local tab chat only.', '互联网副本与竞技场需要协议11的 Worker，诊断面板可查看前后端构建版本。服务器保留未确认的胜利结算，使用同一英雄连接同一服务器和世界可补领。地址留空仅启用本机标签页聊天。'],
      ['Keep your chronicle', '保存你的旅程', 'Only one tab writes a hero. Other tabs can take over and load its latest progress. Export JSON before changing devices or local ports. v9/v10 saves migrate. New chronicles and imports require a verified backup; recovery snapshots remain available in Save.', '同一英雄仅由一个标签页保存，其他标签页可接管并载入最新进度。更换设备或本地端口前请导出 JSON。v9/v10存档自动迁移。新旅程和导入都需先确认备份成功；恢复快照可在存档面板查看。']
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
    const status = document.getElementById('app-save-status');
    if (status) status.textContent = ownership !== 'writer' ? text('Read-only page. Take over to save; exporting is always available.', '本页只读，接管后可保存；随时可以导出。') : lastSaveOk ? text('Auto-save is on. Export JSON to move between devices or launcher ports.', '自动存档已开启。更换设备或启动端口前，请导出 JSON。') : text('Storage unavailable. Export JSON now.', '存储不可用，请导出 JSON。');
    const previous = document.getElementById('app-restore-previous'); if (previous) previous.textContent = text('Restore previous hero backup', '恢复上一位英雄备份');
    const backupList = document.getElementById('app-backup-select');
    if (backupList && document.activeElement !== backupList) {
      const chosen = backupList.value;
      backupList.innerHTML = '<option value="">' + text('Choose a recovery snapshot', '选择恢复快照') + '</option>' + backups().map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name + (item.savedAt ? ' · ' + item.savedAt : '') + (item.key.includes('_conflict_') ? text(' · other page snapshot', ' · 页面冲突快照') : ''))}</option>`).join('');
      backupList.value = chosen;
    }
    const buildLabel = document.getElementById('app-build-label');
    if (buildLabel) { buildLabel.textContent = 'v' + build.version + ' · ' + build.id.slice(0, 7); buildLabel.title = 'Build ' + build.id; }
    renderOwnership(); renderUpdate();
    const heroInput = document.getElementById('input-hero-name');
    if (heroInput && document.activeElement !== heroInput) heroInput.value = state.player.name;
  }
  function scheduleSave() {
    if (savingTimer !== null || ownership !== 'writer') return;
    savingTimer = setTimeout(() => { savingTimer = null; save(false); }, 10000);
  }

  saveGameState = save; loadGameState = load; importSaveJson = importSave; resetNewGame = newGame;
  renderAll = function() { originalRender(); renderIntegration(); scheduleSave(); };
  setLanguage = function(code) { originalLanguage(code); renderIntegration(); };
  applyCharacterConfig = function() {
    if (!canWrite()) return showToast(text('Take over this hero first', '请先接管此英雄'), '', 'border-amber-500');
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
    booted = true;
    if (webLocks) acquireWriter(); else if (claimFallback()) startHeartbeat();
    renderAll();
    if ('serviceWorker' in navigator && ['http:', 'https:'].includes(location.protocol)) {
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).then(value => {
        registration = value;
        if (value.waiting) { latestBuild = latestBuild || { version: text('new build', '新构建') }; renderUpdate(); }
        value.addEventListener('updatefound', () => {
          const worker = value.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) { latestBuild = latestBuild || { version: text('new build', '新构建') }; renderUpdate(); }
          });
        });
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshRequested) location.reload(); });
      }).catch(error => {
        console.info('Offline cache unavailable on this origin:', error.message);
      });
    }
    checkForUpdate();
  };
  function renderUpdate() {
    const banner = document.getElementById('app-update-banner'); if (banner) banner.hidden = !latestBuild;
    const label = document.getElementById('app-update-text');
    if (label) label.textContent = text('A new game build is available. Save your hero and refresh when ready.', '发现游戏更新。准备好后可保存英雄并刷新。');
    const button = document.getElementById('app-update-now'); if (button) { button.textContent = text('Save and update', '保存并更新'); button.disabled = ownership !== 'writer' || refreshRequested; }
  }
  async function checkForUpdate() {
    if (!['http:', 'https:'].includes(location.protocol)) return false;
    try {
      const response = await fetch(new URL('build-info.json', document.baseURI), { cache: 'no-store' });
      if (!response.ok) return false;
      const value = await response.json();
      if (typeof value.id !== 'string' || typeof value.version !== 'string') return false;
      if (value.id !== build.id) { latestBuild = value; renderUpdate(); return true; }
      latestBuild = registration?.waiting ? { version: text('new build', '新构建') } : null;
      renderUpdate();
    } catch (_) { /* Offline play continues with the installed build. */ }
    return false;
  }
  async function saveAndUpdate() {
    if (OnlineRealm.isBusy()) { showToast(text('Finish the online battle first', '请先结束在线战斗'), '', 'border-amber-500'); return false; }
    if (!save(true)) return false;
    if (registration) {
      try {
        // A previously downloaded update is usable even when the network is down.
        if (!registration.waiting) await registration.update();
        if (!registration.waiting) {
          showToast(text('Update is preparing', '正在准备更新'), text('Try again when the new offline shell is ready.', '离线资源准备完成后，请再次点击。'), 'border-sky-500');
          return false;
        }
        refreshRequested = true; stopBackgroundPlay(); renderUpdate();
        registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
        return true;
      } catch (_) {
        refreshRequested = false;
        if (canWrite()) startHeartbeat();
        renderUpdate();
        showToast(text('Update unavailable', '暂时无法更新'), text('Your hero is saved. You can keep playing and retry the update.', '英雄已保存，可以继续游戏并重试更新。'), 'border-amber-500');
        return false;
      }
    }
    refreshRequested = true; stopBackgroundPlay(); location.reload(); return true;
  }
  window.addEventListener('beforeunload', relinquish);
  window.addEventListener('pagehide', relinquish);
  window.addEventListener('pageshow', event => {
    if (event.persisted) { ownership = 'unclaimed'; load(false); acquireWriter().then(ok => { if (ok) startHeartbeat(); }); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) save(false);
    else { if (ownership === 'writer') canWrite(); checkForUpdate(); renderOwnership(); }
  });
  window.addEventListener('storage', event => {
    if (event.key === requestKey && ownership === 'writer') {
      let request; try { request = JSON.parse(event.newValue || 'null'); } catch (_) {}
      if (request?.tabId && request.tabId !== tabId) relinquish({ handoff: true });
    } else if (ownership === 'writer' && (event.key === STORAGE_KEY || event.key === writerKey || event.key === null)) canWrite();
  });
  setInterval(() => { if (ownership === 'writer' && canWrite()) { try { renewLease(); } catch (_) { observe('storage', true); } } }, 5000);
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || GameDirector.isModalOpen()) return;
    for (const id of ['help-modal', 'save-modal', 'char-modal', 'online-modal']) closeModal(id);
  });
  return { normalizeSave, restore, restorePrevious, canWrite, takeOver, exportCurrent, backups, exportBackup, restoreBackup,
    checkForUpdate, saveAndUpdate, getBuild: () => ({ ...build }),
    getSaveStatus: () => ({ ok: lastSaveOk, savedAt: state.savedAt, revision: state.saveRevision || 0, ownership, reason: ownershipReason, conflictKey }) };
})();
window.AethelgardApp = AethelgardApp;
