/* Genuine local AI, bounded context, visible provenance, and an honest rules helper. */
const AethelgardAI = (() => {
  const registry = window.AETHELGARD_MODEL_REGISTRY;
  let worker = null, workerKey = '', requestSequence = 0, operationEpoch = 0, activeRequest = null;
  let workerReady = false, status = 'unloaded', statusDetail = '', progressValue = null;
  let controller = null, pending = new Map(), busy = false, lastResult = null;
  let loadedModel = null, ollamaModels = [], inferenceCount = 0, loadCount = 0;
  const txt = (en, zh) => getLang() === 'zh' ? zh : en;
  const currentModel = () => registry.models.find(m => m.key === ensureState().modelKey) || registry.models[0];
  const esc = value => escapeHtml(String(value ?? ''));
  const storeState = () => { try { saveGameState(false); } catch (_) {} };

  function ensureState() {
    if (!state.ai || typeof state.ai !== 'object') state.ai = {};
    const a = state.ai;
    a.backend = ['rules', 'wasm_onnx', 'local_ollama'].includes(a.backend) ? a.backend : 'wasm_onnx';
    a.modelKey = registry.models.some(m => m.key === a.modelKey) ? a.modelKey : registry.models[0].key;
    a.ollamaUrl = typeof a.ollamaUrl === 'string' ? a.ollamaUrl :
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '/ollama' : 'http://127.0.0.1:11434');
    a.ollamaModel = typeof a.ollamaModel === 'string' ? a.ollamaModel : 'qwen2.5:0.5b';
    a.allowFallback = a.allowFallback === true;
    a.localOnly = a.localOnly === true;
    if (!a.memory || typeof a.memory !== 'object' || Array.isArray(a.memory)) a.memory = {};
    state.aiLogs = Array.isArray(state.aiLogs) ? state.aiLogs.slice(-30) : [];
    for (const item of state.aiLogs) {
      if (!item.source) { item.source = 'legacy-rules'; item.latencyMs = null; item.status = 'complete'; }
    }
    return a;
  }

  function setStatus(next, detail = '') {
    status = next; statusDetail = String(detail).slice(0, 800); render();
  }

  function sourceLabel(source) {
    return ({ wasm: txt('Browser model · CPU', '浏览器模型 · CPU'), ollama: txt('Local Ollama', '本机 Ollama'),
      rules: txt('Rules helper', '规则助手'), 'rules-fallback': txt('Rules fallback', '已回退至规则助手'),
      'legacy-rules': txt('Legacy scripted reply', '旧版脚本回复') })[source] || source || '';
  }

  function getStatus() {
    const a = ensureState();
    return { backend: a.backend, status, detail: statusDetail, busy,
      model: a.backend === 'local_ollama' ? a.ollamaModel : currentModel().id,
      ready: a.backend === 'rules' || (a.backend === 'wasm_onnx' ? workerReady && workerKey === `${currentModel().key}:${a.localOnly}` : ollamaModels.includes(a.ollamaModel)),
      actualLoadedModel: loadedModel, inferenceCount, loadCount, lastResult };
  }

  function cancel(reason = '') {
    requestSequence += 1; operationEpoch += 1;
    if (controller) controller.abort();
    controller = null;
    if (worker && (busy || status === 'loading')) { worker.terminate(); worker = null; workerKey = ''; workerReady = false; loadedModel = null; }
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new DOMException('Cancelled', 'AbortError')); }
    pending.clear();
    if (activeRequest && activeRequest.status === 'generating') {
      activeRequest.status = 'cancelled';
      activeRequest.error = txt('Stopped by player.', '玩家已停止生成。');
    }
    activeRequest = null; busy = false; progressValue = null;
    setStatus(workerReady ? 'ready' : 'unloaded', reason || txt('Stopped. Downloaded files remain cached.', '已停止，已下载的文件仍保留在缓存中。'));
  }

  function selectBackend(mode) {
    const normalized = mode === 'micro_cpu' ? 'rules' : mode;
    if (!['rules', 'wasm_onnx', 'local_ollama'].includes(normalized)) return;
    if (busy || ['loading', 'connecting'].includes(status)) cancel();
    const a = ensureState(); a.backend = normalized;
    setStatus(normalized === 'rules' ? 'ready' :
      (normalized === 'wasm_onnx' && workerReady) || (normalized === 'local_ollama' && ollamaModels.includes(a.ollamaModel)) ? 'ready' : 'unloaded');
    storeState();
  }

  function updateSettings() {
    const a = ensureState();
    const model = document.getElementById('ai-model-select')?.value || a.modelKey;
    const localField = document.getElementById('ai-local-files');
    const localOnly = localField ? !!localField.checked : a.localOnly;
    if (a.modelKey !== model || a.localOnly !== localOnly) {
      if (worker || busy || ['loading', 'connecting'].includes(status)) cancel();
      worker?.terminate(); worker = null; workerReady = false; workerKey = ''; loadedModel = null;
      status = a.backend === 'rules' ? 'ready' : 'unloaded'; statusDetail = '';
    }
    a.modelKey = model; a.localOnly = localOnly;
    const url = document.getElementById('ai-ollama-url')?.value.trim();
    const ollamaModel = document.getElementById('ai-ollama-model')?.value.trim();
    if (url && (url !== a.ollamaUrl || ollamaModel !== a.ollamaModel)) {
      if (busy || status === 'connecting') cancel();
      ollamaModels = [];
    }
    if (url) a.ollamaUrl = url;
    if (ollamaModel) a.ollamaModel = ollamaModel;
    const fallbackField = document.getElementById('ai-allow-fallback');
    if (fallbackField) a.allowFallback = !!fallbackField.checked;
    storeState(); render();
  }

  function workerJob(type, payload, onChunk, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++requestSequence;
      const timer = setTimeout(() => {
        pending.delete(id); worker?.terminate(); worker = null; workerReady = false; workerKey = ''; loadedModel = null;
        reject(new Error(txt('Local model timed out. Retry or use the lighter model.', '本地模型超时。请重试或选择较轻量的模型。')));
      }, timeoutMs);
      pending.set(id, { resolve, reject, onChunk, timer });
      worker.postMessage({ type, id, ...payload });
    });
  }

  async function verifyOfflinePackage(model, baseUrl) {
    const response = await fetch(new URL('models/offline-manifest.json', baseUrl).href, { cache: 'no-store' });
    if (!response.ok) throw new Error(txt('Offline manifest is missing. Run tools/prepare_offline.py first.', '缺少离线包清单。请先运行 tools/prepare_offline.py。'));
    const manifest = await response.json();
    const exactModel = Array.isArray(manifest.models) && manifest.models.find(item => item.key === model.key && item.id === model.id && item.revision === model.revision && item.dtype === model.dtype);
    if (manifest.runtime !== registry.runtime || !exactModel || !manifest.files || typeof manifest.files !== 'object') {
      throw new Error(txt('Offline package runtime or model revision does not match this game. Prepare the selected model again.', '离线包的运行时或模型版本与本游戏不符。请重新准备当前模型。'));
    }
    const required = [...model.files.map(name => `models/${model.id}/${name}`), ...(registry.runtimeFiles || ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']).map(name => `vendor/${name}`)];
    for (const name of required) {
      if (!/^[a-f0-9]{64}$/i.test(manifest.files[name] || '')) throw new Error(`${txt('Offline package file is missing:', '离线包缺少文件：')} ${name}`);
    }
    for (const [name, digest] of Object.entries(model.sha256 || {})) {
      if (manifest.files[`models/${model.id}/${name}`] !== digest) throw new Error(txt('Offline model weight hash does not match the pinned registry.', '离线模型权重校验值与固定注册表不符。'));
    }
    // This validates package identity and coverage without loading a second
    // 600 MB copy into browser memory. prepare_offline.py verifies file bytes.
    return manifest;
  }

  async function loadBrowserModel() {
    updateSettings();
    const a = ensureState();
    if (busy || status === 'loading') return;
    if (a.backend !== 'wasm_onnx') selectBackend('wasm_onnx');
    if (location.protocol === 'file:') {
      setStatus('error', txt('Start the game with start_Windows.cmd or python tools/serve.py, then load the model.', '请先用 start_Windows.cmd 或 python tools/serve.py 启动网页，再加载模型。')); return;
    }
    const model = currentModel();
    const key = `${model.key}:${a.localOnly}`;
    if (workerReady && workerKey === key) { setStatus('ready'); return; }
    const epoch = ++operationEpoch, capturedState = state;
    setStatus('loading', txt('Preparing inference runtime…', '正在准备本地推理引擎…'));
    progressValue = null;
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller === null) {
        // Cache runtime resources from the first model load when the origin supports SW.
        await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 2500))]);
      }
      if (epoch !== operationEpoch || state !== capturedState || ensureState().backend !== 'wasm_onnx') return;
      const baseUrl = new URL('./', document.baseURI).href;
      if (a.localOnly) await verifyOfflinePackage(model, baseUrl);
      if (epoch !== operationEpoch || state !== capturedState || ensureState().backend !== 'wasm_onnx' || key !== `${currentModel().key}:${ensureState().localOnly}`) return;
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      worker?.terminate();
      worker = new Worker(new URL('assets/ai-worker.js', document.baseURI), { type: 'module', name: 'aethelgard-local-dm' });
      const createdWorker = worker;
      workerKey = key;
      worker.onmessage = event => {
        const message = event.data || {}, job = pending.get(message.id);
        if (!job) return;
        if (message.type === 'progress') {
          const p = message.progress || {};
          progressValue = Number.isFinite(p.progress) ? Math.max(0, Math.min(100, p.progress)) : null;
          const mb = Number.isFinite(p.total) && p.total > 0 && Number.isFinite(p.loaded) ? ` ${(p.loaded / 1e6).toFixed(1)} / ${(p.total / 1e6).toFixed(1)} MB` : '';
          statusDetail = `${p.status || ''} ${p.file || ''}${mb}`; render(); return;
        }
        if (message.type === 'chunk') { job.onChunk?.(message); return; }
        clearTimeout(job.timer); pending.delete(message.id);
        if (message.type === 'error') job.reject(new Error(message.message));
        else job.resolve(message);
      };
      worker.onerror = event => {
        if (worker !== createdWorker) return;
        for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(event.message || 'Worker failed')); }
        pending.clear(); workerReady = false; loadedModel = null;
      };
      const ready = await workerJob('load', { config: {
        model, localOnly: a.localOnly, baseUrl, runtimeVersion: registry.runtime,
        runtimeUrl: a.localOnly ? new URL('vendor/transformers.min.js', baseUrl).href : registry.runtimeUrl,
        wasmPaths: a.localOnly ? new URL('vendor/', baseUrl).href : undefined
      } }, null, 900000);
      if (epoch !== operationEpoch || state !== capturedState || ensureState().backend !== 'wasm_onnx' || workerKey !== key || key !== `${currentModel().key}:${ensureState().localOnly}`) return;
      workerReady = true; loadedModel = ready.model; loadCount += 1; progressValue = 100;
      setStatus('ready', `${model.name} · ${model.dtype} · CPU/WASM · ${txt('loaded', '已加载')} ${(ready.loadMs / 1000).toFixed(1)}s${ready.cacheEnabled === false ? txt(' · Cache unavailable on this origin; use HTTPS or localhost for offline reuse.', ' · 当前来源不支持缓存；离线复用请使用 HTTPS 或 localhost。') : ''}`);
    } catch (error) {
      if (epoch !== operationEpoch || state !== capturedState) return;
      workerReady = false; loadedModel = null;
      if (error.name !== 'AbortError') setStatus('error', String(error.message));
    }
  }

  function endpoint() {
    const a = ensureState();
    const u = new URL(a.ollamaUrl, location.href);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    const localProxy = u.origin === location.origin && /^\/ollama\/?$/.test(u.pathname) && loopback;
    if (!loopback || !['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      throw new Error(txt('Ollama must use a localhost address. Cloud model endpoints are not used.', 'Ollama 地址必须指向本机 localhost。此功能不使用云端模型。'));
    }
    if (!localProxy && u.pathname !== '/' && u.pathname !== '') throw new Error('Use the Ollama server address without /api/chat.');
    return u.href.replace(/\/$/, '');
  }

  async function connectOllama() {
    updateSettings(); if (busy) return;
    selectBackend('local_ollama'); setStatus('connecting', txt('Checking local models…', '正在检查本机模型…'));
    const epoch = ++operationEpoch, capturedState = state, ownController = new AbortController();
    let timer;
    try {
      controller = ownController; timer = setTimeout(() => ownController.abort(), 10000);
      const response = await fetch(`${endpoint()}/api/tags`, { signal: ownController.signal });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      const data = await response.json();
      if (epoch !== operationEpoch || state !== capturedState || ensureState().backend !== 'local_ollama') return;
      ollamaModels = (data.models || []).map(m => m.name || m.model).filter(name => typeof name === 'string' && !/cloud/i.test(name));
      if (!ollamaModels.length) throw new Error(txt('No local model found. Run: ollama pull qwen2.5:0.5b', '没有发现已下载的本地模型。请执行：ollama pull qwen2.5:0.5b'));
      const a = ensureState();
      if (!ollamaModels.includes(a.ollamaModel)) a.ollamaModel = ollamaModels.find(n => n.startsWith('qwen2.5:0.5b')) || ollamaModels[0];
      const field = document.getElementById('ai-ollama-model'); if (field) field.value = a.ollamaModel;
      setStatus('ready', `${txt('Local service connected; model loads on first question', '本机服务已连接，首次提问时载入模型')} · ${a.ollamaModel}`);
      storeState();
    } catch (error) {
      if (epoch !== operationEpoch || state !== capturedState) return;
      ollamaModels = [];
      setStatus('error', `${error.message}. ${txt('Check Ollama, browser local-network permission, and OLLAMA_ORIGINS; the local launcher avoids CORS.', '请检查 Ollama、本地网络权限和 OLLAMA_ORIGINS；本地启动器可避免跨域问题。')}`);
    } finally { clearTimeout(timer); if (controller === ownController) controller = null; }
  }

  function findRoute(targetId) {
    const start = state.world.currentRoom;
    const queue = [[start, []]], seen = new Set([start]);
    while (queue.length) {
      const [id, path] = queue.shift(); if (id === targetId) return path;
      for (const [direction, next] of Object.entries(WORLD_ROOMS[id]?.exits || {})) {
        if (WORLD_ROOMS[next] && !seen.has(next)) { seen.add(next); queue.push([next, [...path, direction]]); }
      }
    }
    return null;
  }

  function relevantPlaces(question) {
    const q = question.toLowerCase();
    const aliases = [
      [/\b(inn|tavern|pub)\b|酒馆|旅馆|客栈/, 'r_tavern'],
      [/\b(blacksmith|forge)\b|铁匠|锻造/, 'r_blacksmith'],
      [/\b(alchemist|potion|shop)\b|药剂|药水|商店/, 'r_alchemist'],
      [/\bguild\b|公会/, 'r_guild_hall'],
      [/\bmythril\b|秘银/, 'r_slag_foundry']
    ];
    const ids = new Set(aliases.filter(([pattern]) => pattern.test(q)).map(([, id]) => id));
    const words = q.split(/[^a-z0-9]+/).filter(w => w.length > 3 && !['where','about','there','could','would','please','with','this','that','what'].includes(w));
    for (const room of Object.values(WORLD_ROOMS)) {
      const resourceMatch = (room.nodes || []).some(n => q.includes(String(n.item || '').toLowerCase()) ||
        (ITEM_CATALOG[n.item]?.nameZh && q.includes(ITEM_CATALOG[n.item].nameZh)));
      if (q.includes(room.titleZh) || words.some(w => room.title.toLowerCase().includes(w)) || resourceMatch) ids.add(room.id);
    }
    return [...ids].filter(id => WORLD_ROOMS[id]).slice(0, 4).map(id => ({ id, name: trRoomTitle(WORLD_ROOMS[id]), route: findRoute(id) }));
  }

  function contextFor(question, kind) {
    const p = state.player, room = WORLD_ROOMS[state.world.currentRoom];
    const npc = kind === 'npc' ? room?.npcs?.[0] : null;
    const stats = computeDerivedStats();
    const director = typeof GameDirector !== 'undefined' ? GameDirector.getContext() : {};
    const combat = typeof CombatDirector !== 'undefined' ? CombatDirector.getContext() : null;
    return {
      hero: { name: p.name, class: getLang() === 'zh' ? CLASS_CONFIG[p.classId].nameZh : CLASS_CONFIG[p.classId].name,
        level: p.level, hp: `${p.hp}/${p.maxHp}`, mp: `${p.mp}/${p.maxMp}`, stamina: `${p.sta}/${p.maxSta}`, gold: p.gold, stance: p.stance,
        stats: { atk: stats.atk, mag: stats.mag, def: stats.def },
        equipment: Object.fromEntries(Object.entries(p.equipment).filter(([, v]) => v).map(([k, v]) => [k, trEntityName(ITEM_CATALOG[v] || { name: v, nameZh: v })])) },
      room: { name: trRoomTitle(room), safe: !!room.safe, biome: room.biome,
        exits: Object.fromEntries(Object.entries(room.exits || {}).map(([d, id]) => [d, WORLD_ROOMS[id] ? trRoomTitle(WORLD_ROOMS[id]) : id])),
        resources: (room.nodes || []).map(n => n.item) },
      npc: npc ? { name: trEntityName(npc), role: npc.role, lore: getLang() === 'zh' ? npc.dialogueZh : npc.dialogue } : null,
      quest: STORY_QUESTS.filter(q => !state.quests.completed.includes(q.id)).slice(0, 1).map(q => ({
        name: getLang() === 'zh' ? q.titleZh : q.title, description: getLang() === 'zh' ? (q.descZh || q.desc) : q.desc })),
      enemy: state.combat.inCombat && state.combat.enemy ? { name: trEntityName(state.combat.enemy), hp: state.combat.enemy.hp,
        intent: typeof CombatDirector !== 'undefined' ? CombatDirector.getIntent?.() || state.combat.enemy.intent : state.combat.enemy.intent } : null,
      weather: state.weather, time: state.timeOfDay,
      places: relevantPlaces(question),
      combat: combat ? { enemy: combat.enemy, skills: combat.skills, decisions: combat.decisions,
        potions: Object.entries(p.inventory).filter(([id, count]) => count > 0 && ITEM_CATALOG[id]?.type === 'consumable').map(([id, count]) => ({ name: trEntityName(ITEM_CATALOG[id]), count })) } : null,
      adventure: { chapter: director.chapter, objective: director.objective, objectiveRoom: director.objectiveRoom, trust: director.trust,
        flags: director.flags, encounter: kind === 'encounter' ? director.encounter : undefined,
        recentJournal: Array.isArray(director.journal) ? director.journal.slice(-2) : undefined }
    };
  }

  function isCombatQuestion(question, kind, context) {
    return !!context.enemy && (kind === 'tactics' || /fight|attack|skill|combat|interrupt|potion|guard|spell|enemy|charge|battle|defend|damage|what should|what.*next|战斗|攻击|技能|防御|怎么打|打断|药水|药剂|施法|敌人|蓄力|重击|伤害|怎么办|怎么做|下一步/.test(question.toLowerCase()));
  }

  function buildMessages(question, kind, scope) {
    const a = ensureState(), context = contextFor(question, kind);
    if (kind === 'encounter') {
      // The authored opening owns the story. Earlier chat and possible outcomes
      // must not turn an absent character or an unchosen action into a new fact.
      return [{ role: 'system', content: txt(
        'You are a scene narrator. Write 1-2 short English sentences from the supplied opening. Preserve each person\'s location, presence or absence, and everything still unresolved. Only add sensory atmosphere such as light, sound or smell. Do not add people, actions or events, choose for the player, or repeat instructions. Output only the scene.',
        '你是场景旁白。根据原文写一到两句简体中文，保留人物的位置、在场或缺席状态，以及尚未发生的事。只补充光线、声音、气味等感官氛围；不新增人物、行动或事件，不替玩家选择，不复述要求。直接输出场景描写。') },
      { role: 'user', content: `${txt('CURRENT SCENE', '当前场景原文')}\n${factsFor(question, kind, context)}\n\n${question}` }];
    }
    const asksRoute = context.places.length && !['tactics', 'encounter'].includes(kind) && /\b(where|route|reach|travel|find|directions?)\b|哪里|何处|怎么去|路线|前往|怎样到|方向|朝哪|哪边|怎么走/.test(question.toLowerCase());
    const asksMemory = /\b(remember|recall|earlier|previously)\b|what (?:did|have) i (?:tell|told|say)|\bmy (?:sister|brother|friend|companion)\b|记住|记得|回忆|刚才|先前|之前.*(?:说|告诉|名字)|我的?(?:姐姐|妹妹|哥哥|弟弟|旅伴)/i.test(question);
    const role = asksRoute ? txt('You are a game guide. Give the actual movement direction in the supplied route.', '你是游戏向导。请直接说明所给路线中的实际移动方向。') :
      kind === 'tactics' || isCombatQuestion(question, kind, context) ? txt('You advise a hero in a turn-based fantasy battle. Explain the recommended legal action and its effect.', '你是回合制奇幻游戏的战术顾问。请解释推荐的合法行动及其效果。') :
      asksMemory ? txt("You remember the player's conversation. Answer their current question about it.", '你负责记住玩家的对话。请回答玩家当前关于对话的问题。') :
      kind === 'npc' && context.npc ? txt(`You are ${context.npc.name}, a character in the fantasy game Aethelgard.`, `你是奇幻游戏艾瑟尔加德中的角色${context.npc.name}。`) : txt("You are the storyteller in the fantasy game Aethelgard. Answer the player's latest question.", '你是奇幻游戏艾瑟尔加德的故事主持人。请回答玩家当前的问题。');
    const instructions = role + txt(' Reply in English in 1-2 short sentences. Use game facts for world state and earlier conversation for remembered people and promises. Do not invent rewards, exits or completed actions.', '用简体中文回答一到两句。游戏状态以游戏事实为准，人物和约定可从先前对话中回忆。不要编造奖励、出口或已经完成的行动。');
    const memory = Array.isArray(a.memory[scope]) ? a.memory[scope].filter(m => ['user', 'assistant'].includes(m.role)).slice(-8) : [];
    const memoryFocus = asksMemory && !asksRoute && !isCombatQuestion(question, kind, context) && !['tactics', 'encounter'].includes(kind);
    return [{ role: 'system', content: instructions },
      ...memory.map(m => ({ role: m.role, content: String(m.content).slice(0, 700) })),
      { role: 'user', content: memoryFocus ? question : `${txt('GAME FACTS', '游戏事实')}\n${factsFor(question, kind, context)}\n\n${txt('Player asks', '玩家提问')}: ${question}` }];
  }

  function factsFor(question, kind, context = contextFor(question, kind)) {
    const lines = [txt(`Current location: ${context.room.name}.`, `当前位置：${context.room.name}。`)];
    if (kind === 'encounter' && context.adventure.encounter) {
      const event = context.adventure.encounter;
      lines.push(event.title + ': ' + event.opening);
      lines.push(txt('The player has not chosen. The scene remains at its opening.', '玩家尚未选择，场景仍停留在开场。'));
      return lines.join('\n');
    }
    const directions = getLang() === 'zh' ? DIR_ZH : { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };
    const asksRoute = /\b(where|route|reach|travel|find|directions?)\b|哪里|何处|怎么去|路线|前往|怎样到|方向|朝哪|哪边|怎么走/.test(question.toLowerCase());
    if (context.places.length && asksRoute && !['tactics', 'encounter'].includes(kind)) {
      for (const place of context.places.slice(0, 2)) lines.push(place.route === null ? txt(`No known route to ${place.name}.`, `暂无前往${place.name}的路线。`) :
        !place.route.length ? txt(`You are already at ${place.name}.`, `你已经位于${place.name}。`) :
        txt(`To reach ${place.name} from here: go ${place.route.map(d => directions[d] || d).join(', then ')}.`, `从这里前往${place.name}：依次向${place.route.map(d => directions[d] || d).join('、')}移动。`));
      if (context.enemy) lines.push(txt('You are in combat. Finish the battle or successfully flee before travelling.', '你正在战斗中，必须先结束战斗或成功撤退，才能沿路线移动。'));
      return lines.join('\n');
    }
    if (/\b(remember|recall|earlier|previously)\b|what (?:did|have) i (?:tell|told|say)|\bmy (?:sister|brother|friend|companion)\b|记住|记得|回忆|刚才|先前|之前.*(?:说|告诉|名字)|我的?(?:姐姐|妹妹|哥哥|弟弟|旅伴)/i.test(question)) {
      return txt('People and promises mentioned by the player can be recalled from the current and earlier conversation.', '人物名字和约定以玩家当前和先前对话中说过的内容为准。');
    }
    if (isCombatQuestion(question, kind, context)) {
      const c = context.combat, e = c?.enemy;
      const interrupt = c?.decisions?.interrupt;
      const recommendation = interrupt?.effectiveNow && interrupt.canPay ? txt('Interrupt now: spend 18 STA to cancel the enemy charge or spell and expose the enemy.', '现在打断：消耗18体力，取消敌人的蓄力或施法，并使其露出破绽。') :
        ['heavy', 'charge', 'cast', 'guard'].includes(e?.intent) ? txt('Guard now: reduce damage by 65% and recover 18 STA and 8 MP.', '现在防御：减少65%伤害，恢复18体力与8法力。') :
        txt('Attack, or use an available damaging skill. Use a healing item first if your health is low.', '可以攻击，或使用当前可用的伤害技能；生命偏低时优先治疗。');
      lines.push(txt('Recommended action: ', '推荐行动：') + recommendation);
      lines.push(`HP ${context.hero.hp}, MP ${context.hero.mp}, STA ${context.hero.stamina}.`);
      const neutralIntent = {
        strike: txt('Quick attack', '准备快速攻击'), charge: txt('Charging a heavy blow', '正在蓄力重击'),
        heavy: txt('A heavy blow is about to land', '重击即将落下'), cast: txt('Casting a spell', '正在吟唱法术'),
        recover: txt('Recovering and exposed', '正在恢复，露出破绽'), guard: txt('Defending', '正在防御')
      }[e?.intent] || String(e?.intent || context.enemy.intent);
      lines.push(txt(`Enemy: ${context.enemy.name}, ${e?.hp} HP. Intent: ${neutralIntent}.`, `敌人：${context.enemy.name}，${e?.hp}生命。意图：${neutralIntent}。`));
      if (e?.phaseName) lines.push(txt(`Phase: ${e.phaseName}.`, `阶段：${e.phaseName}。`));
      if (interrupt?.canPay) lines.push(txt('Can afford interrupt: yes.', '当前体力足够支付打断。'));
      else lines.push(txt('Can afford interrupt: no. Interrupt is unavailable this turn because stamina is below 18. Guard is available at zero stamina.', '当前体力不足18，本回合无法使用打断。防御在零体力时仍然可用。'));
      const asksDetails = /skill|spell|potion|cooldown|suppl|cost|技能|施法|药水|药剂|冷却|补给|消耗/.test(question.toLowerCase());
      if (asksDetails) {
        lines.push(txt('Guard reduces incoming damage by 65%. Interrupt costs 18 STA and stops only a charge or spell.', '防御减少本回合65%伤害。打断消耗18体力，只能阻止蓄力或施法。'));
        lines.push(txt('Skills: ', '技能：') + (c?.skills || []).map(s => `${getLang() === 'zh' ? s.nameZh : s.name}: ${s.cost}${s.pool}, ${s.cooldown} ${txt('turn cooldown', '回合冷却')}, ${s.available ? txt('usable', '可用') : txt('unavailable', '不可用')}`).join('; '));
        lines.push(txt('Supplies: ', '补给：') + (c?.potions || []).map(p => `${p.name} ×${p.count}`).join(', '));
      }
      lines.push(txt('The recommended action spends one player turn. The battle continues afterwards. Explain this action and its listed effect.', '推荐行动会消耗玩家一个回合，随后战斗继续。请解释这项行动及上面列出的效果。'));
      return lines.join('\n');
    }
    if (/\b(gold|money|health|hp|mp|stamina|potion|supplies|inventory)\b|金币|金钱|生命|血量|法力|体力|药水|药剂|补给|背包/.test(question.toLowerCase())) {
      lines.push(`HP ${context.hero.hp}, MP ${context.hero.mp}, STA ${context.hero.stamina}. ${txt('Gold', '金币')}: ${context.hero.gold}.`);
      lines.push(txt('Supplies: ', '补给：') + ((context.combat?.potions || []).map(p => `${p.name} ×${p.count}`).join(', ') || txt('none', '无')));
      if (context.room.safe) lines.push(txt('This is a safe place to rest.', '此处安全，可以完全休息。'));
      return lines.join('\n');
    }
    if (context.npc) lines.push(txt(`What you know: ${context.npc.lore}`, `你知道的事情：${context.npc.lore}`));
    lines.push(txt(`Traveler: ${context.hero.name}, level ${context.hero.level} ${context.hero.class}.`, `旅人：${context.hero.name}，${context.hero.level}级${context.hero.class}。`));
    lines.push(txt(`Current goal: ${context.adventure.objective || context.quest[0]?.description || 'Explore the region.'}`, `当前目标：${context.adventure.objective || context.quest[0]?.description || '探索此区域。'}`));
    if (kind === 'tactics') lines.push(`HP ${context.hero.hp}, MP ${context.hero.mp}, STA ${context.hero.stamina}. ${context.room.safe ? txt('This is a safe place to rest.', '此处安全，可以完全休息。') : txt('Rest fully at a safe settlement.', '完全休息需要返回安全据点。')}`);
    else if (context.adventure.recentJournal?.length) {
      const recent = context.adventure.recentJournal.at(-1);
      lines.push(txt('Recent choice: ', '最近经历：') + `${recent.title}. ${recent.text || ''}`.slice(0, 450));
    }
    return lines.join('\n');
  }

  function rulesReply(question, kind) {
    const started = performance.now(), context = contextFor(question, kind), q = question.toLowerCase();
    const p = state.player;
    let text;
    const route = context.places[0];
    if (route && kind !== 'tactics' && /\b(where|route|find|reach)\b|哪里|怎么去|路线|前往/.test(q)) {
      const steps = route.route;
      text = steps === null ? txt('That location is not currently connected to your map.', '该地点暂时没有可到达的路线。') : !steps.length ?
        txt(`You are already at ${route.name}.`, `你已经在【${route.name}】。`) :
        txt(`To reach ${route.name}, follow ${steps.join(' → ')}. Check the danger level before leaving a safe room.`,
          `前往【${route.name}】的路线：${steps.map(d => DIR_ZH[d] || d).join(' → ')}。离开安全区前，请查看目的地危险等级。`);
    } else if (isCombatQuestion(question, kind, context)) {
      text = factsFor(question, kind, context);
    } else if (kind === 'tactics' || /\b(advice|tactic|build|fight)\b|建议|攻略|怎么打/.test(q)) {
      text = p.hp < p.maxHp * .45 ? txt('Your health is low. Use a healing item, guard against a heavy attack, or retreat to a safe room before resting.', '你的生命值偏低。可使用治疗物品、格挡敌人的重击，或先撤回安全区域休息。') :
        state.combat.inCombat ? txt('Read the enemy intent. Guard a heavy strike, interrupt a charge, and spend MP when the enemy is exposed.', '先看敌人预兆：重击时格挡、蓄力时打断、破绽出现时再消耗法力输出。') :
        txt(`Explore an unvisited exit, gather needed materials, or pursue ${context.quest[0]?.name || 'a regional encounter'}. Your next choice should advance a goal.`, `可探索尚未到达的出口、收集所需材料，或推进【${context.quest[0]?.name || '区域奇遇'}】。优先选择能推进目标的行动。`);
    } else if (/\b(gold|money|health|hp|mp|stamina|potion|supplies|inventory)\b|金币|生命|血量|法力|体力|药水|补给|背包/.test(q)) {
      text = factsFor(question, kind, context);
    } else if (kind === 'npc' && context.npc) {
      text = `${context.npc.name}: ${context.npc.lore} ${txt('Ask for a route, or load a local model for an open conversation.', '你可以询问路线，或加载本地模型进行自由对话。')}`;
    } else {
      text = txt(`You are in ${context.room.name}. Exits: ${Object.entries(context.room.exits).map(([d, n]) => `${d}: ${n}`).join('; ')}. This rules helper can show routes and basic tactics. Load a local model for roleplay and free-form questions.`,
        `你位于【${context.room.name}】。出口：${Object.entries(context.room.exits).map(([d, n]) => `${DIR_ZH[d] || d}：${n}`).join('；')}。规则助手支持路线与基础建议；加载本地模型后可进行角色扮演和自由提问。`);
    }
    return { text, source: 'rules', model: null, latencyMs: performance.now() - started, outputTokens: null };
  }

  async function ollamaReply(messages, onChunk) {
    const a = ensureState(), started = performance.now();
    if (!a.ollamaModel.trim() || /cloud|:\/\//i.test(a.ollamaModel)) throw new Error(txt('Choose a downloaded local model, such as qwen2.5:0.5b.', '请选择已下载的本地模型，例如 qwen2.5:0.5b。'));
    const ownController = new AbortController(); controller = ownController;
    const timer = setTimeout(() => ownController.abort(), 180000);
    let text = '', final = null, firstTokenMs = null;
    try {
      const response = await fetch(`${endpoint()}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ownController.signal,
        body: JSON.stringify({ model: a.ollamaModel, messages, stream: true, keep_alive: '5m',
          options: { temperature: .65, num_predict: 180, num_ctx: 2048, num_gpu: 0 } })
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const accept = packet => {
        if (packet.error) throw new Error(packet.error);
        const chunk = packet.message?.content || '';
        if (chunk) { if (firstTokenMs === null) firstTokenMs = performance.now() - started; text += chunk; onChunk({ text: chunk }); }
        if (packet.done) final = packet;
        if (text.length > 16000) throw new Error('Model output exceeded the response limit.');
      };
      if (!response.body?.getReader) accept(await response.json());
      else {
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) { buffer += decoder.decode(); break; }
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, split).trim(); buffer = buffer.slice(split + 1);
            if (line) accept(JSON.parse(line));
          }
        }
        if (buffer.trim()) accept(JSON.parse(buffer));
      }
      if (!final || !text.trim()) throw new Error('Ollama stream ended without a completed answer.');
      const latencyMs = performance.now() - started;
      return { text: text.trim(), source: 'ollama', model: final.model || a.ollamaModel,
        latencyMs, firstTokenMs, inputTokens: final.prompt_eval_count, outputTokens: final.eval_count,
        tokensPerSecond: final.eval_count && final.eval_duration ? final.eval_count / (final.eval_duration / 1e9) : null,
        modelLoadMs: final.load_duration ? final.load_duration / 1e6 : null };
    } finally { clearTimeout(timer); if (controller === ownController) controller = null; }
  }

  async function ask(rawQuestion, options = {}) {
    const question = String(rawQuestion || '').trim().slice(0, 1200);
    if (!question || busy || status === 'loading') return null;
    const a = ensureState(), kind = options.kind || 'npc';
    const npcId = WORLD_ROOMS[state.world.currentRoom]?.npcs?.[0]?.id;
    const scope = kind === 'npc' && npcId ? `npc:${npcId}` : 'dm';
    const capturedState = state;
    const entry = { id: Date.now() + '-' + (++requestSequence), prompt: question, text: '', lang: getLang(),
      source: a.backend === 'wasm_onnx' ? 'wasm' : a.backend === 'local_ollama' ? 'ollama' : 'rules',
      status: 'generating', room: state.world.currentRoom, latencyMs: null };
    entry.facts = factsFor(question, kind);
    state.aiLogs.push(entry); if (state.aiLogs.length > 30) state.aiLogs.shift();
    busy = true; activeRequest = entry; setStatus('generating');
    const onChunk = chunk => { if (activeRequest === entry && state === capturedState) { entry.text += chunk.text || ''; render(); } };
    try {
      let result;
      if (a.backend === 'rules') result = rulesReply(question, kind);
      else {
        const messages = buildMessages(question, kind, scope);
        if (a.backend === 'wasm_onnx') {
          if (!workerReady || workerKey !== `${currentModel().key}:${a.localOnly}`) {
            throw new Error(txt('Load the browser model first, or select Rules helper.', '请先点击“下载并加载模型”，或明确选择“规则助手”。'));
          }
          result = await workerJob('generate', { messages, maxNewTokens: options.maxNewTokens }, onChunk, 240000);
        } else result = await ollamaReply(messages, onChunk);
      }
      if (activeRequest !== entry || state !== capturedState) return null;
      Object.assign(entry, result, { status: 'complete' });
      if (result.source === 'wasm' || result.source === 'ollama') { inferenceCount += 1; loadedModel = result.model; }
      if (result.source === 'ollama' && !ollamaModels.includes(a.ollamaModel)) ollamaModels.push(a.ollamaModel);
      lastResult = { source: result.source, model: result.model, latencyMs: result.latencyMs,
        firstTokenMs: result.firstTokenMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        tokensPerSecond: result.tokensPerSecond, completedAt: new Date().toISOString() };
      a.memory[scope] = [...(Array.isArray(a.memory[scope]) ? a.memory[scope] : []),
        { role: 'user', content: question }, { role: 'assistant', content: result.text }].slice(-12);
      const memoryKeys = Object.keys(a.memory); if (memoryKeys.length > 40) delete a.memory[memoryKeys[0]];
      addLog(result.text, 'ai', 'text-sky-200', result.text);
      storeState(); return result;
    } catch (error) {
      if (activeRequest !== entry || state !== capturedState) return null;
      if (error.name === 'AbortError') { entry.status = 'cancelled'; entry.error = txt('Generation stopped.', '已停止生成。'); return null; }
      entry.status = 'error'; entry.error = String(error.message || error).slice(0, 800);
      if (a.allowFallback && a.backend !== 'rules') {
        const result = rulesReply(question, kind);
        Object.assign(entry, result, { source: 'rules-fallback', status: 'complete', fallbackReason: entry.error });
        addLog(entry.text, 'ai', 'text-amber-200', entry.text); storeState();
        return { ...result, source: 'rules-fallback', fallbackReason: entry.error };
      }
      return null;
    } finally {
      if (activeRequest === entry) {
        activeRequest = null; busy = false;
        setStatus(entry.status === 'error' ? 'error' : getStatus().ready ? 'ready' : 'unloaded', entry.error || '');
      }
    }
  }

  async function narrateEncounter(id, token) {
    if (typeof GameDirector === 'undefined') return;
    const event = GameDirector.getContext().encounter;
    if (!event || (id && event.id !== id) || (token && event.token !== token)) return;
    switchRightTab('ai');
    const question = txt(`Add 1-2 sentences of sensory atmosphere to this encounter: ${event.title}.`,
      `请为当前奇遇【${event.title}】补充一到两句感官氛围描写。`);
    const result = await ask(question, { kind: 'encounter' });
    if (result && ['wasm', 'ollama'].includes(result.source)) GameDirector.setNarration(event.id, result.text, result.source, event.token);
  }

  function clearMemory() {
    if (busy) return;
    ensureState().memory = {}; state.aiLogs = []; lastResult = null; storeState(); render();
  }

  function resetSession() {
    cancel();
    worker?.terminate(); worker = null; workerKey = ''; workerReady = false;
    ollamaModels = []; loadedModel = null; lastResult = null;
    status = 'unloaded'; statusDetail = ''; progressValue = null;
  }

  function render() {
    const a = ensureState(), model = currentModel();
    const pill = document.getElementById('ai-engine-status-pill');
    const statusNames = { unloaded: txt('Not loaded', '尚未加载'), loading: txt('Loading model', '正在加载模型'),
      connecting: txt('Connecting', '正在连接'), ready: txt('Ready', '可用'), generating: txt('Generating', '正在生成'), error: txt('Needs attention', '需要处理') };
    const label = a.backend === 'rules' ? txt('Rules helper', '规则助手') : a.backend === 'wasm_onnx' ? model.name : 'Ollama';
    if (pill) { pill.textContent = `${label} · ${statusNames[status] || status}`; pill.dataset.state = status; }
    const header = document.getElementById('header-ai-badge');
    if (header) header.textContent = `🧠 ${a.backend === 'rules' ? txt('Rules', '规则') : 'AI'} · ${statusNames[status] || status}`;
    const detail = document.getElementById('ai-status-detail'); if (detail) { detail.textContent = statusDetail; detail.dataset.state = status; }
    const bar = document.getElementById('ai-download-progress');
    if (bar) { bar.hidden = status !== 'loading'; if (!Number.isFinite(progressValue)) bar.removeAttribute('value'); else bar.value = Math.max(0, Math.min(100, progressValue)); }
    const note = document.getElementById('ai-model-note');
    if (note) note.textContent = (a.localOnly ? txt('Read from the local model package; no download needed. Speed depends on your computer.', '从本地模型包读取，不需下载；速度取决于你的电脑。') : `${txt('First download', '首次下载')} ≈${model.downloadMB} MB + ${txt('runtime; subsequent runs use cache. CPU speed depends on your device.', '推理引擎；之后使用缓存。生成速度取决于你的电脑。')}`) + (model.key === 'smol-135m' ? txt(' English model; use Qwen for Chinese.', ' 此模型以英文为主，中文请选 Qwen。') : '');
    const ids = { rules: 'btn-ai-mode-micro', wasm_onnx: 'btn-ai-mode-wasm', local_ollama: 'btn-ai-mode-ollama' };
    for (const [mode, id] of Object.entries(ids)) {
      const b = document.getElementById(id); if (b) { b.className = `ai-control ${a.backend === mode ? 'ai-primary' : ''}`; b.setAttribute('aria-pressed', String(a.backend === mode)); }
    }
    const loadButton = document.getElementById('ai-load-model');
    if (loadButton) { loadButton.disabled = busy || status === 'loading'; loadButton.textContent = a.localOnly ? txt('Load offline model', '加载离线模型') : txt('Download / load model', '下载并加载模型'); }
    const sendButton = document.getElementById('btn-ai-prompt-send'); if (sendButton) sendButton.disabled = busy || status === 'loading';
    const cancelButton = document.getElementById('ai-cancel'); if (cancelButton) cancelButton.disabled = !busy && status !== 'loading';
    const browserSettings = document.getElementById('ai-browser-settings'); if (browserSettings) browserSettings.hidden = a.backend !== 'wasm_onnx';
    const ollamaSettings = document.getElementById('ai-ollama-settings'); if (ollamaSettings) ollamaSettings.hidden = a.backend !== 'local_ollama';
    const history = document.getElementById('ai-chat-log');
    if (history) {
      const stickBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 60;
      history.innerHTML = state.aiLogs.length ? state.aiLogs.map(item => {
        const text = item.text || (getLang() === 'zh' ? item.zh : item.en) || '';
        const time = Number.isFinite(item.latencyMs) ? ` · ${(item.latencyMs / 1000).toFixed(2)}s` : '';
        const tokens = Number.isFinite(item.outputTokens) ? ` · ${item.outputTokens} tokens` : '';
        const rate = Number.isFinite(item.tokensPerSecond) ? ` · ${item.tokensPerSecond.toFixed(1)} tok/s` : '';
        const importantFacts = /To reach |No known route|You are already at|Recommended action:|^HP |从这里前往|暂无前往|你已经位于|推荐行动：/m.test(item.facts || '');
        const facts = item.facts ? `<details class="ai-note mb-1" data-authority="game-rules"${importantFacts ? ' open' : ''} style="border-left:2px solid #38bdf8;padding-left:8px"><summary>${txt('Game rules / actual state at the time of this question', '游戏规则 / 提问时的实际状态')}</summary><div class="whitespace-pre-wrap">${esc(item.facts)}</div></details>` : '';
        const originalLabel = ['wasm', 'ollama'].includes(item.source) ? `<div class="ai-note">${txt('Model response · original text', '模型回复 · 原文')}</div>` : '';
        return `<div class="ai-message" data-source="${esc(item.source)}" data-status="${esc(item.status)}"><div class="text-amber-200 mb-1">${esc(item.prompt)}</div>${facts}${originalLabel}<div class="ai-answer">${esc(text || (item.status === 'generating' ? txt('Thinking…', '正在思考…') : ''))}</div>${item.error ? `<div class="text-rose-300 mt-1">${esc(item.error)}</div>` : ''}<div class="ai-meta">${esc(sourceLabel(item.source))}${item.model ? ' · ' + esc(item.model.split('/').pop()) : ''}${time}${tokens}${rate}</div></div>`;
      }).join('') : `<div class="ai-note p-2">${txt('Load a local model to begin a conversation. Ask about your journey, speak to an NPC, or request a tactical explanation.', '加载本地模型即可开始对话。可以询问旅程、与 NPC 交谈，或请智脑解释战术。')}</div>`;
      if (stickBottom || busy) history.scrollTop = history.scrollHeight;
    }
    const diagnostics = document.getElementById('ai-diagnostics');
    if (diagnostics) diagnostics.textContent = JSON.stringify({ backend: a.backend, status, model: loadedModel,
      successfulModelLoads: loadCount, successfulInferences: inferenceCount, lastResult }, null, 2);
  }

  function mount() {
    const panel = document.getElementById('panel-ai'); if (!panel) return;
    const a = ensureState();
    panel.innerHTML = `
      <div class="ai-settings"><div class="font-bold text-sky-300">${txt('Your local Dungeon Master', '你的本地地下城主持人')}</div>
      <div class="grid grid-cols-3 gap-1"><button id="btn-ai-mode-micro" onclick="setAiBackend('rules')" class="ai-control">${txt('Rules', '规则助手')}</button><button id="btn-ai-mode-wasm" onclick="setAiBackend('wasm_onnx')" class="ai-control">${txt('Browser CPU', '浏览器 CPU')}</button><button id="btn-ai-mode-ollama" onclick="setAiBackend('local_ollama')" class="ai-control">Ollama</button></div>
      <div id="ai-engine-status-pill" class="ai-status" role="status" aria-live="polite"></div>
      <div id="ai-browser-settings" class="ai-settings"><label for="ai-model-select">${txt('Local model', '本地模型')}</label><select id="ai-model-select" onchange="AethelgardAI.updateSettings()">${registry.models.map(m => `<option value="${m.key}" ${m.key === a.modelKey ? 'selected' : ''}>${esc(getLang() === 'zh' ? m.nameZh : m.name)}</option>`).join('')}</select>
      <div id="ai-model-note" class="ai-note"></div><label><input id="ai-local-files" type="checkbox" style="width:auto" ${a.localOnly ? 'checked' : ''} onchange="AethelgardAI.updateSettings()"> ${txt('Use downloaded offline package', '使用已下载的离线模型包')}</label>
      <button id="ai-load-model" class="ai-control ai-primary" onclick="AethelgardAI.loadBrowserModel()">${txt('Download / load model', '下载并加载模型')}</button><progress id="ai-download-progress" class="ai-progress" max="100" hidden></progress></div>
      <div id="ai-ollama-settings" class="ai-settings" hidden><label for="ai-ollama-url">${txt('Local service', '本机服务地址')}</label><input id="ai-ollama-url" value="${esc(a.ollamaUrl)}" onchange="AethelgardAI.updateSettings()"><label for="ai-ollama-model">${txt('Installed model', '已下载的模型')}</label><input id="ai-ollama-model" value="${esc(a.ollamaModel)}" list="ai-local-models" onchange="AethelgardAI.updateSettings()"><datalist id="ai-local-models">${ollamaModels.map(m => `<option value="${esc(m)}">`).join('')}</datalist><button class="ai-control ai-primary" onclick="AethelgardAI.connectOllama()">${txt('Connect / check models', '连接并检测模型')}</button><div class="ai-note">${txt('Install a model with: ollama pull qwen2.5:0.5b. The Windows launcher provides a same-origin local bridge.', '先执行 ollama pull qwen2.5:0.5b。本地 Windows 启动器提供同源桥接。')}</div></div>
      <div id="ai-status-detail" class="ai-status" role="status"></div>
      <label><input id="ai-allow-fallback" type="checkbox" style="width:auto" ${a.allowFallback ? 'checked' : ''} onchange="AethelgardAI.updateSettings()"> ${txt('Allow clearly labeled rules fallback on failure', '模型失败时允许明确标记的规则回复')}</label></div>
      <div class="ai-actions"><button class="ai-control" onclick="askNpcAi()">${txt('Speak to NPC', '与 NPC 交谈')}</button><button class="ai-control" onclick="askAiTactics()">${txt('Tactical advice', '战术建议')}</button><button class="ai-control" onclick="triggerAiEncounter()">${txt('Discover an encounter', '寻找奇遇')}</button></div>
      <div id="ai-chat-log" class="bg-slate-950 border border-slate-700 rounded-lg overflow-y-auto" role="log" aria-label="${txt('Conversation', '对话记录')}"></div>
      <form id="ai-prompt-form" onsubmit="handleAiPromptSubmit(event)" class="flex gap-1"><input id="ai-prompt-input" maxlength="1200" class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2" aria-label="${txt('Ask your DM', '向智脑提问')}" placeholder="${txt('How do I reach the tavern?', '我该怎样前往酒馆？')}"><button id="btn-ai-prompt-send" class="ai-control ai-primary" type="submit">${txt('Ask', '提问')}</button></form>
      <div class="ai-actions"><button id="ai-cancel" class="ai-control" onclick="AethelgardAI.cancel()">${txt('Stop', '停止')}</button><button class="ai-control" onclick="AethelgardAI.clearMemory()">${txt('Clear dialogue memory', '清除对话记忆')}</button></div>
      <details class="ai-note"><summary>${txt('Inference evidence', '推理运行记录')}</summary><pre id="ai-diagnostics" class="whitespace-pre-wrap break-all text-[10px]"></pre><p>${txt('Narration never changes rewards or combat outcomes; your choices are resolved by game rules.', '叙事不会自行发放奖励或改变战斗结果；你的选择由游戏规则结算。')}</p></details>`;
    render();
  }

  return { ensureState, getStatus, getDiagnostics: getStatus, selectBackend, updateSettings,
    loadBrowserModel, connectOllama, ask, cancel, resetSession, clearMemory, narrateEncounter, mount, render,
    buildMessages, contextFor, factsFor, rulesReply, findRoute, endpoint, verifyOfflinePackage };
})();
window.AethelgardAI = AethelgardAI;

function setAiBackend(mode) { AethelgardAI.selectBackend(mode); }
function renderAiPanel() { AethelgardAI.render(); }
function askNpcAi(question) {
  const npc = WORLD_ROOMS[state.world.currentRoom]?.npcs?.[0];
  return AethelgardAI.ask(question || (getLang() === 'zh' ? `请介绍你自己，以及这里有什么值得关注的事情。` : 'Introduce yourself and tell me what matters here.'), { kind: npc ? 'npc' : 'general' });
}
function askAiTactics() { return AethelgardAI.ask(getLang() === 'zh' ? '根据我的当前状态，下一步应该怎么做？请解释原因。' : 'Given my current state, what should I do next and why?', { kind: 'tactics' }); }
function handleAiPromptSubmit(event) {
  event?.preventDefault(); const input = document.getElementById('ai-prompt-input');
  if (!input || !input.value.trim()) return;
  const q = input.value.trim(); input.value = ''; return askNpcAi(q);
}
