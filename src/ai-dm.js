/* Genuine local AI, bounded context, visible provenance, and an honest rules helper. */
const AethelgardAI = (() => {
  const registry = window.AETHELGARD_MODEL_REGISTRY;
  let worker = null, workerKey = '', requestSequence = 0, operationEpoch = 0, resumeSequence = 0, activeRequest = null;
  let workerReady = false, status = 'unloaded', statusDetail = '', progressValue = null;
  let controller = null, pending = new Map(), busy = false, lastResult = null;
  let loadedModel = null, ollamaModels = [], inferenceCount = 0, loadCount = 0;
  const txt = (en, zh) => getLang() === 'zh' ? zh : en;
  const currentModel = () => registry.models.find(m => m.key === ensureState().modelKey) || registry.models[0];
  const esc = value => escapeHtml(String(value ?? ''));
  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const bounded = (value, length = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, length) : '';
  const normalizedId = value => typeof value === 'string' ? bounded(value, 100) : Number.isSafeInteger(value) ? String(value) : '';
  const newEntryId = () => `${Date.now()}-${++requestSequence}`;
  const entryId = entry => entry.id = normalizedId(entry.id) || newEntryId();
  const validScope = key => key === 'dm' || /^npc:[a-z0-9_-]{1,80}$/i.test(key);
  const storeState = () => { if (window.AethelgardApp?.canWrite?.() === false) return; try { saveGameState(false); } catch (_) {} };
  function canMutate() {
    if (window.AethelgardApp?.canWrite?.() !== false) return true;
    setStatus('error', txt('This tab is read-only. Continue in the tab that owns this save before changing the conversation.', '此标签页为只读。请在拥有存档写入权的标签页继续对话。'));
    return false;
  }

  // These are player statements, never model-written world facts. Scope keeps
  // one NPC's private conversation separate from another NPC's conversation.
  const relationNames = {
    sister: ['sister', '姐妹'], brother: ['brother', '兄弟'], older_sister: ['older sister', '姐姐'], younger_sister: ['younger sister', '妹妹'],
    older_brother: ['older brother', '哥哥'], younger_brother: ['younger brother', '弟弟'], friend: ['friend', '朋友'], companion: ['companion', '旅伴'],
    mother: ['mother', '母亲'], father: ['father', '父亲'], child: ['child', '孩子']
  };
  const relationKey = value => ({ 姐姐:'older_sister',妹妹:'younger_sister',哥哥:'older_brother',弟弟:'younger_brother',朋友:'friend',旅伴:'companion',同伴:'companion',母亲:'mother',妈妈:'mother',父亲:'father',爸爸:'father',孩子:'child' })[value] || value;
  function extractPlayerFacts(raw) {
    const input = bounded(raw, 1200), found = [];
    const english = /\bmy\s+(?:(?:missing|lost|older|younger|little|dear)\s+)*(sister|brother|friend|companion|mother|father|child)(?:'s)?\s+(?:is\s+(?:named\s+|called\s+)?|name\s+is\s+)([A-Za-z][A-Za-z'’-]{0,23})(?=[.!?,;\s]|$)/gi;
    const chinese = /我(?:的)?(?:失散的|失踪的|走失的|亲爱的)?(姐姐|妹妹|哥哥|弟弟|朋友|旅伴|同伴|母亲|妈妈|父亲|爸爸|孩子)(?:的)?(?:(?:名字)?(?:名叫|叫做|叫)|名字是)[“"「]?([\u3400-\u9fffA-Za-z·'’-]{1,12})(?=[”"」。，！？、；,!?;\s]|$)/g;
    for (const pattern of [english, chinese]) for (const match of input.matchAll(pattern)) {
      const name = match[2], relation = relationKey(match[1].toLowerCase());
      if (!Object.hasOwn(relationNames, relation) || /^(?:not|unknown|missing|lost|what|who|谁|什么|不|无|没|正在|已经)/i.test(name)) continue;
      if (pattern === english && !/\b(?:named|called|name)\b/i.test(match[0]) && !/^[A-Z]/.test(name)) continue;
      const prefix = input.slice(0, match.index).split(/[.。!！?？\n]/).at(-1);
      if (/你(?:刚才)?说|你告诉我|假如|如果|是否|\byou (?:said|told)|\bif\b/i.test(prefix) || /^[?？]/.test(input.slice(match.index + match[0].length))) continue;
      found.push({ key: `person:${relation}`, type: 'person', relation, name, text: match[0], source: 'player' });
    }
    const promises = [...input.matchAll(/(?:\bI\s+(?:promise|pledge)\s+(?:to\s+)?[^.!?\n]{3,150}|我(?:向[^。，！？\n]{1,20})?(?:承诺|保证|答应)[^。，！？\n]{2,120})/gi)];
    for (const match of promises.slice(0, 3)) {
      const text = match[0], prefix = input.slice(0, match.index).split(/[.。!！?？\n]/).at(-1);
      if (/什么|是否|谁|哪|吗|呢|\b(?:what|which|who|whether)\b/i.test(text) || /你(?:刚才)?说|如果|\b(?:what|did|do|should|would|you said|if)\b/i.test(prefix) || /^[?？]/.test(input.slice(match.index+text.length))) continue;
      let hash = 2166136261; for (const ch of text.toLowerCase()) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
      found.push({ key: `promise:${hash}`, type: 'promise', text, source: 'player' });
    }
    return found;
  }
  function mergePlayerFacts(knowledge, scope, text) {
    if (!validScope(scope)) return;
    const facts = extractPlayerFacts(text);
    if (!facts.length) return;
    const existing = Array.isArray(knowledge.scopes[scope]) ? knowledge.scopes[scope] : [];
    for (const fact of facts) {
      const old = existing.findIndex(item => item.key === fact.key);
      if (old >= 0) existing.splice(old, 1);
      existing.push({ ...fact, updatedAt: Date.now() });
    }
    knowledge.scopes[scope] = existing.slice(-20);
    const keys = Object.keys(knowledge.scopes); if (keys.length > 40) delete knowledge.scopes[keys[0]];
  }

  function ensureState() {
    if (!record(state.ai)) state.ai = {};
    const a = state.ai;
    a.backend = ['rules', 'wasm_onnx', 'local_ollama'].includes(a.backend) ? a.backend : 'wasm_onnx';
    a.modelKey = registry.models.some(m => m.key === a.modelKey) ? a.modelKey : registry.models[0].key;
    a.ollamaUrl = typeof a.ollamaUrl === 'string' ? a.ollamaUrl :
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? '/ollama' : 'http://127.0.0.1:11434');
    a.ollamaModel = typeof a.ollamaModel === 'string' ? a.ollamaModel : 'qwen2.5:0.5b';
    a.allowFallback = a.allowFallback === true;
    a.localOnly = a.localOnly === true;
    if (!a.memory || typeof a.memory !== 'object' || Array.isArray(a.memory)) a.memory = {};
    a.memory = Object.fromEntries(Object.entries(a.memory).filter(([key, value]) => validScope(key) && Array.isArray(value)).slice(-40).map(([key, value]) =>
      [key, value.filter(m => record(m) && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-12).map(m => ({ role: m.role, content: bounded(m.content, 1200) }))]));
    if (!record(a.knowledge) || a.knowledge.version !== 1 || !record(a.knowledge.scopes)) {
      a.knowledge = { version: 1, scopes: {} };
      for (const [scope, memory] of Object.entries(a.memory)) for (const m of memory) if (m.role === 'user') mergePlayerFacts(a.knowledge, scope, m.content);
    } else {
      a.knowledge.scopes = Object.fromEntries(Object.entries(a.knowledge.scopes).filter(([scope, facts]) => validScope(scope) && Array.isArray(facts)).slice(-40).map(([scope, facts]) => [scope,
        facts.filter(f => record(f) && f.source === 'player' && ['person', 'promise'].includes(f.type) && typeof f.text === 'string').slice(-20).map(f => ({
          key: bounded(f.key, 80), type: f.type, source: 'player', text: bounded(f.text, 180),
          ...(f.type === 'person' && Object.hasOwn(relationNames, f.relation) ? { relation: f.relation, name: bounded(f.name, 24) } : {}),
          updatedAt: Number.isFinite(f.updatedAt) ? f.updatedAt : 0
        })).filter(f => f.key && (f.type !== 'person' || f.name))]));
    }
    state.aiLogs = Array.isArray(state.aiLogs) ? state.aiLogs.filter(record).slice(-30) : [];
    const usedIds = new Set(), identities = [];
    for (const [index, item] of state.aiLogs.entries()) {
      const previousId = normalizedId(item.id);
      while (usedIds.has(entryId(item))) item.id = newEntryId();
      usedIds.add(item.id); identities.push({ item, previousId, index });
      if (!item.source) { item.source = 'legacy-rules'; item.latencyMs = null; item.status = 'complete'; }
    }
    if (record(a.pendingQuestion) && typeof a.pendingQuestion.question === 'string') a.pendingQuestion = {
      id: normalizedId(a.pendingQuestion.id) || newEntryId(), question: bounded(a.pendingQuestion.question, 1200),
      kind: ['general', 'npc', 'tactics', 'encounter'].includes(a.pendingQuestion.kind) ? a.pendingQuestion.kind : 'general',
      room: bounded(a.pendingQuestion.room, 100), npcId: bounded(a.pendingQuestion.npcId, 100),
      eventId: bounded(a.pendingQuestion.eventId, 100), eventToken: bounded(a.pendingQuestion.eventToken, 180)
    }; else a.pendingQuestion = null;
    if (a.pendingQuestion) {
      const matched = identities.filter(({ item, previousId }) => previousId === a.pendingQuestion.id && bounded(item.prompt, 1200) === a.pendingQuestion.question && bounded(item.room, 100) === a.pendingQuestion.room).at(-1);
      if (matched) a.pendingQuestion.id = entryId(matched.item);
    }
    a.feedback = (Array.isArray(a.feedback) ? a.feedback : []).filter(record).slice(-20).map(item => {
      const oldId = normalizedId(item.entryId), prompt = bounded(item.prompt, 1200), answer = bounded(item.answer, 16000);
      const matches = identities.filter(({item:log, previousId, index}) =>
        (oldId === previousId || oldId === entryId(log) || oldId === bounded(`legacy:${index}:${bounded(log.prompt, 50)}`, 100) || oldId.startsWith('legacy:')) &&
        bounded(log.prompt, 1200) === prompt && bounded(log.text, 16000) === answer && (!item.room || bounded(log.room, 100) === bounded(item.room, 100)));
      return {
      id: normalizedId(item.id) || newEntryId(), entryId: matches.length === 1 ? entryId(matches[0].item) : oldId, category: ['facts', 'persona', 'scene', 'other'].includes(item.category) ? item.category : 'other',
      recordedAt: bounded(item.recordedAt, 40), prompt: bounded(item.prompt, 1200), facts: bounded(item.facts, 4500),
      answer: bounded(item.answer, 16000), source: bounded(item.source, 40), model: bounded(item.model, 200),
      revision: bounded(item.revision, 80), dtype: bounded(item.dtype, 24), runtime: bounded(item.runtime, 80),
      room: bounded(item.room, 100), language: bounded(item.language, 8), gameVersion: bounded(item.gameVersion, 30)
    }; });
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

  function rememberPending(entry) {
    if (!entry?.prompt || window.AethelgardApp?.canWrite?.() === false) return;
    ensureState().pendingQuestion = { id: entryId(entry), question: entry.prompt, kind: entry.kind || 'general', room: entry.room,
      npcId: entry.npcId || '', eventId: entry.eventId || '', eventToken: entry.eventToken || '' };
    const input = document.getElementById('ai-prompt-input'); if (input && !input.value) input.value = entry.prompt;
  }

  function cancel(reason = '', options = {}) {
    requestSequence += 1; operationEpoch += 1; resumeSequence += 1;
    if (controller) controller.abort();
    controller = null;
    if (worker && (busy || status === 'loading')) { worker.terminate(); worker = null; workerKey = ''; workerReady = false; loadedModel = null; }
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new DOMException('Cancelled', 'AbortError')); }
    pending.clear();
    if (activeRequest && activeRequest.status === 'generating') {
      if (options.preserveQuestion !== false) rememberPending(activeRequest);
      activeRequest.status = 'cancelled';
      activeRequest.error = txt('Stopped by player.', '玩家已停止生成。');
    }
    activeRequest = null; busy = false; progressValue = null;
    setStatus(getStatus().ready ? 'ready' : 'unloaded', reason || txt('Stopped. Your question is kept. Reload and continue to reuse cached or local files; missing files may still need downloading.', '已停止，问题已保留。点击“重新加载并继续”可复用缓存或本地文件；缺失文件仍需下载。'));
    if (options.persist !== false) storeState();
  }

  function selectBackend(mode) {
    if (!canMutate()) return;
    const normalized = mode === 'micro_cpu' ? 'rules' : mode;
    if (!['rules', 'wasm_onnx', 'local_ollama'].includes(normalized)) return;
    if (busy || ['loading', 'connecting'].includes(status)) cancel();
    const a = ensureState(); a.backend = normalized;
    setStatus(normalized === 'rules' ? 'ready' :
      (normalized === 'wasm_onnx' && workerReady) || (normalized === 'local_ollama' && ollamaModels.includes(a.ollamaModel)) ? 'ready' : 'unloaded');
    storeState();
  }

  function updateSettings() {
    if (!canMutate()) return false;
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
    storeState(); render(); return true;
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
    if (!canMutate() || updateSettings() === false) return;
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
    if (!canMutate() || updateSettings() === false || busy) return;
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

  const npcFactions = { elder_thorne:'town', forgemaster_brom:'forge', alchemist_lyra:'town', commander_vance:'town',
    innkeeper_mara:'town', captain_sorin:'town', scout_elara:'rangers', sister_vesper:'echoes', engineer_borin:'forge' };
  const factionNames = { town:['Oakhaven','橡木港'], rangers:['The Rangers','荒野游侠'], echoes:['The Unbound','自由亡魂'],
    forge:['The Forgekin','熔炉族裔'], astral:['Rift Scholars','裂隙学者'] };
  const localText = value => bounded(typeof value === 'string' ? value : value?.[getLang() === 'zh' ? 'zh' : 'en'], 600);
  function termsFor(question) {
    const lower = String(question).toLowerCase(), terms = lower.match(/[a-z][a-z'-]{2,}/g) || [];
    for (const segment of lower.match(/[\u3400-\u9fff]{2,}/g) || []) for (let i=0; i<Math.min(segment.length-1, 48); i++) terms.push(segment.slice(i, i+2));
    return [...new Set(terms)].filter(term => !['the','and','you','what','please','with','that','this','remember','请问','刚才','记得'].includes(term)).slice(0, 60);
  }
  const relevance = (text, terms) => terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term) ? 1 : 0), 0);
  function playerFactsFor(question, scope) {
    const a = ensureState(), facts = [...(a.knowledge.scopes[scope] || [])];
    // Reading old/imported recent user turns is safe; assistant turns are never
    // extracted. Persistent capture normally happens when ask() accepts input.
    for (const message of a.memory[scope] || []) if (message.role === 'user') for (const fact of extractPlayerFacts(message.content)) {
      if (!facts.some(old => old.key === fact.key)) facts.push(fact);
    }
    const terms = termsFor(question);
    return facts.map((fact, index) => ({ fact, index, score: relevance(`${fact.text} ${fact.relation || ''} ${fact.name || ''}`, terms) +
      (fact.type === 'person' && /name|named|called|名字|姓名|叫什么/i.test(question) ? 2 : 0) +
      (fact.type === 'promise' && /promise|pledge|承诺|答应|约定|保证/i.test(question) ? 3 : 0) }))
      .sort((a,b) => b.score-a.score || b.index-a.index).slice(0, 4).map(({fact}) => fact.type === 'person' ?
        txt(`Player says their ${relationNames[fact.relation][0]} is named ${fact.name}.`, `玩家明确说过：${relationNames[fact.relation][1]}叫${fact.name}。`) :
        txt(`Player's promise, not proof it was fulfilled: ${fact.text}`, `玩家的承诺（不代表已履行）：${fact.text}`));
  }
  function rememberPlayerStatement(question, scope = 'dm') {
    if (!canMutate()) return false;
    const a = ensureState(); mergePlayerFacts(a.knowledge, scope, question); storeState(); return true;
  }
  function npcFactsFor(question, context) {
    const npc = context.npc;
    if (!npc) return [];
    const lines = [txt(`Speaker: ${npc.name}. Listener: ${context.hero.name}. Speak as yourself; do not call the listener by your own name.`,
      `说话者：${npc.name}。听话者：${context.hero.name}。以自己身份说话，不要把自己的名字当作对方姓名。`),
      txt(`Role: ${npc.role}.`, `身份：${npc.role}。`)];
    if (npc.faction && factionNames[npc.faction]) {
      const trust = Number(context.adventure.trust?.[npc.faction]) || 0;
      const attitude = trust >= 3 ? txt('trusting', '信任') : trust > 0 ? txt('warming to the traveler', '渐生好感') : trust <= -3 ? txt('distrustful', '不信任') : trust < 0 ? txt('wary', '有所戒备') : txt('not yet acquainted', '尚未建立信任');
      lines.push(txt(`Your faction: ${factionNames[npc.faction][0]}. Trust ${trust}; attitude: ${attitude}.`, `所属阵营：${factionNames[npc.faction][1]}。信任 ${trust}；态度：${attitude}。`));
    }
    const terms = termsFor(`${question} ${npc.name}`), journal = context.adventure.journal || [];
    const selected = journal.filter(item => item.kind === 'choice' || item.kind === 'boss' || item.kind === 'story')
      .map((item,index) => ({item,index,score: relevance(`${item.title} ${item.text}`, terms)*3 + (item.roomId === context.room.id ? 8 : 0) +
        (WORLD_ROOMS[item.roomId]?.biome === context.room.biome ? 2 : 0)}))
      .sort((a,b) => b.score-a.score || b.index-a.index).slice(0,2);
    for (const {item} of selected) lines.push(txt('Recorded event: ', '规则已记录的经历：') + bounded(`${item.title}: ${item.text}`, 230));
    // Long-lived story flags survive journal rotation. Only explicitly authored
    // meanings are translated here; unknown flags never become invented lore.
    const known = [
      ['scout_saved',['rangers','town'],'The wounded ranger was rescued.','受伤游侠已获救。'],
      ['scout_abandoned',['rangers','town'],'The traveler took the wounded ranger’s purse and left.','旅人拿走受伤游侠的钱袋后离开。'],
      ['mill_repaired',['town'],'The mill was repaired and flour returned to Oakhaven.','磨坊已修复，面粉重新送回橡木港。'],
      ['brom_letter',['forge'],'Brom sent word of the traveler to Borin.','布罗姆已向博林捎去关于旅人的口信。'],
      ['shield_first',['town','forge'],'The traveler took the shield while the patrol waited.','旅人先领取圆盾，巡逻队仍需等待。']
    ];
    const flags = known.filter(([key,factions]) => context.adventure.flags?.[key] === true && factions.includes(npc.faction));
    flags.sort((a,b) => relevance(txt(b[2],b[3]),terms)-relevance(txt(a[2],a[3]),terms));
    for (const fact of flags.slice(0,2)) lines.push(txt('Established fact: ', '已发生的事实：') + txt(fact[2],fact[3]));
    return lines;
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
      room: { id: state.world.currentRoom, name: trRoomTitle(room), safe: !!room.safe, biome: room.biome,
        exits: Object.fromEntries(Object.entries(room.exits || {}).map(([d, id]) => [d, WORLD_ROOMS[id] ? trRoomTitle(WORLD_ROOMS[id]) : id])),
        resources: (room.nodes || []).map(n => n.item) },
      npc: npc ? { id: npc.id, name: trEntityName(npc), role: npc.role, faction: npcFactions[npc.id] || null, lore: getLang() === 'zh' ? npc.dialogueZh : npc.dialogue } : null,
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
        recentJournal: Array.isArray(director.journal) ? director.journal.slice(-2) : undefined,
        journal: (Array.isArray(state.director?.journal) ? state.director.journal : []).slice(-100).filter(record).map(j => ({
          title: localText(j.title), text: localText(j.body), kind: j.kind, roomId: j.roomId })) }
    };
  }

  function isCombatQuestion(question, kind, context) {
    return !!context.enemy && (kind === 'tactics' || /fight|attack|skill|combat|interrupt|potion|guard|spell|enemy|charge|battle|defend|damage|what should|what.*next|战斗|攻击|技能|防御|怎么打|打断|药水|药剂|施法|敌人|蓄力|重击|伤害|怎么办|怎么做|下一步/.test(question.toLowerCase()));
  }

  function classifyIntent(question, kind, context = contextFor(question, kind)) {
    const q = question.toLowerCase();
    const asksMemory = /\b(remember|recall|earlier|previously)\b|what (?:did|have) i (?:tell|told|say)|\bmy (?:sister|brother|friend|companion)\b|记住|记得|回忆|刚才|先前|之前.*(?:说|告诉|名字)|我的?(?:姐姐|妹妹|哥哥|弟弟|旅伴)/i.test(q);
    const asksRoute = !!context.places.length && !['tactics', 'encounter'].includes(kind) && /\b(where|route|reach|travel|find|directions?)\b|哪里|何处|怎么去|路线|前往|怎样到|方向|朝哪|哪边|怎么走/.test(q);
    const asksResources = /\b(gold|money|health|hp|mp|stamina|potion|supplies|inventory)\b|金币|金钱|生命|血量|法力|体力|药水|药剂|补给|背包/.test(q);
    const asksRelationship = !!context.npc && /trust|wary|distrust|relationship|attitude|信任|戒备|态度|看法|关系|救过|钱袋/.test(q);
    return { primary: kind === 'encounter' ? 'encounter' : asksRoute ? 'route' : isCombatQuestion(q, kind, context) ? 'combat' :
      asksResources ? 'resources' : kind === 'tactics' ? 'tactics' : asksRelationship ? 'relationship' : asksMemory ? 'memory' : kind === 'npc' && context.npc ? 'npc' : 'general',
      asksMemory, asksDetails: /skill|potion|cooldown|suppl|cost|技能|可用法术|哪些法术|药水|药剂|冷却|补给|消耗/.test(q) };
  }

  function recommendedActionText(action, combat) {
    const labels = { interrupt:txt('Interrupt now', '现在打断'), guard:txt('Guard now', '现在防御'), attack:txt('Attack now', '现在攻击'),
      flee:txt('Retreat now', '现在撤退'), ultimate:txt('Use Overdrive', '释放超载必杀'), potion:txt('Use a healing item', '使用治疗物品'), skill:txt('Use a skill', '使用技能') };
    const skill = action.kind === 'skill' ? combat.skills?.find(s => s.index === action.index) : null;
    const item = action.itemId && ITEM_CATALOG[action.itemId];
    let detail = getLang() === 'zh' ? action.reasonZh : action.reasonEn;
    if (action.kind === 'interrupt' && combat.decisions.interrupt.effect) detail = txt(`Spend ${combat.decisions.interrupt.staminaCost} STA. `, `消耗${combat.decisions.interrupt.staminaCost}体力。`) + (getLang() === 'zh' ? combat.decisions.interrupt.effect.descriptionZh : combat.decisions.interrupt.effect.descriptionEn);
    return `${labels[action.kind] || action.kind}${skill ? ' · ' + (getLang() === 'zh' ? skill.nameZh : skill.name) : item ? ' · ' + trEntityName(item) : ''}: ${detail || ''}`;
  }

  function buildMessages(question, kind, scope) {
    const a = ensureState(), context = contextFor(question, kind), intent = classifyIntent(question, kind, context);
    if (kind === 'encounter') {
      // The authored opening owns the story. Earlier chat and possible outcomes
      // must not turn an absent character or an unchosen action into a new fact.
      return [{ role: 'system', content: txt(
        'You are a scene narrator. Write 1-2 short English sentences from the supplied opening. Preserve each person\'s location, presence or absence, and everything still unresolved. Only add sensory atmosphere such as light, sound or smell. Do not add people, actions or events, choose for the player, or repeat instructions. Output only the scene.',
        '你是场景旁白。根据原文写一到两句简体中文，保留人物的位置、在场或缺席状态，以及尚未发生的事。只补充光线、声音、气味等感官氛围；不新增人物、行动或事件，不替玩家选择，不复述要求。直接输出场景描写。') },
      { role: 'user', content: `${txt('CURRENT SCENE', '当前场景原文')}\n${factsFor(question, kind, context)}\n\n${question}` }];
    }
    const role = intent.primary === 'route' ? txt('You are a game guide. Give the actual movement direction in the supplied route.', '你是游戏向导。请直接说明所给路线中的实际移动方向。') :
      ['combat', 'tactics'].includes(intent.primary) ? txt('You advise a hero in a turn-based fantasy battle. Name only the recommended action, then explain its listed effect and cost. Do not borrow effects from other actions.', '你是回合制奇幻游戏的战术顾问。先说推荐的行动，再说明列明的效果与消耗。只解释这一项行动，不混入其他技能或动作。') :
      context.npc ? txt(`You are ${context.npc.name}. The person you address is ${context.hero.name}; never address them by your own name.`, `你是${context.npc.name}，对话者是${context.hero.name}。不要用自己的名字称呼对方。`) :
      intent.primary === 'memory' ? txt("Recall the player's supplied statements. Answer each part of the question, including both a name and a promise when asked.", '你负责回忆玩家明确提供的资料。逐项回答问题；若问姓名与承诺，两项都要回答。') : txt("You are the storyteller in the fantasy game Aethelgard. Answer the player's latest question.", '你是奇幻游戏艾瑟尔加德的故事主持人。请回答玩家当前的问题。');
    const instructions = role + (intent.primary === 'relationship' ? txt(' Explain your current attitude using the faction trust and recorded event supplied below.', '请用下方阵营信任和已发生事件解释你对旅人的态度。') : '') +
      txt(' Reply in English in 1-2 short sentences. Game facts decide world state. Player statements and earlier conversation recall names and promises only; a promise is not a completed action. Prior assistant prose is not evidence. Do not invent rewards, exits or completed actions.', '用简体中文回答一到两句。世界状态以游戏事实为准。玩家声明与先前对话只用于回忆人物和约定；承诺不等于完成，旧助手回复不是事实证据。不要编造奖励、出口或已完成的行动。');
    let memory = Array.isArray(a.memory[scope]) ? a.memory[scope].filter(m => ['user', 'assistant'].includes(m.role)).slice(-8) : [];
    const remembered = playerFactsFor(question, scope);
    if (intent.primary === 'memory' && remembered.length) memory = memory.filter(m => m.role === 'user' && relevance(m.content, termsFor(question)) > 0).slice(-4);
    const playerNotes = remembered.length ? `${txt('REMEMBERED PLAYER STATEMENTS (not world-state proof)', '玩家明确提供的记忆（不是世界状态的证明）')}\n${remembered.join('\n')}\n\n` : '';
    const facts = factsFor(question, kind, context, intent);
    const memoryWorld = intent.primary === 'memory' && context.npc ? `${txt('GAME FACTS', '游戏事实')}\n${npcFactsFor(question, context).join('\n')}\n\n` : '';
    return [{ role: 'system', content: instructions },
      ...memory.map(m => ({ role: m.role, content: String(m.content).slice(0, 700) })),
      { role: 'user', content: intent.primary === 'memory' ? `${memoryWorld}${playerNotes}${question}` : `${txt('GAME FACTS', '游戏事实')}\n${facts}\n\n${playerNotes}${txt('Player asks', '玩家提问')}: ${question}` }];
  }

  function factsFor(question, kind, context = contextFor(question, kind), intent = classifyIntent(question, kind, context)) {
    const lines = [txt(`Current location: ${context.room.name}.`, `当前位置：${context.room.name}。`)];
    if (kind === 'encounter' && context.adventure.encounter) {
      const event = context.adventure.encounter;
      lines.push(event.title + ': ' + event.opening);
      if (event.id === 'tavern_courier') lines.push(txt('Scene boundary: Mara and the traveler are in the tavern; the courier is absent. The wounded ranger and waterwheel are only mentioned in the note, not present or audible here. Use the hearth light, empty chair, or soup smell for atmosphere.', '场景边界：玛拉与旅人在酒馆，信使仍然缺席。受伤游侠和水车只在字条里提及，不在现场，也不能听见水车声。氛围只围绕炉火光线、空椅子或热汤气味展开。'));
      lines.push(txt('The player has not chosen. The scene remains at its opening.', '玩家尚未选择，场景仍停留在开场。'));
      return lines.join('\n');
    }
    const directions = getLang() === 'zh' ? DIR_ZH : { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };
    if (intent.primary === 'route') {
      for (const place of context.places.slice(0, 2)) lines.push(place.route === null ? txt(`No known route to ${place.name}.`, `暂无前往${place.name}的路线。`) :
        !place.route.length ? txt(`You are already at ${place.name}.`, `你已经位于${place.name}。`) :
        txt(`To reach ${place.name} from here: go ${place.route.map(d => directions[d] || d).join(', then ')}.`, `从这里前往${place.name}：依次向${place.route.map(d => directions[d] || d).join('、')}移动。`));
      if (context.enemy) lines.push(txt('You are in combat. Finish the battle or successfully flee before travelling.', '你正在战斗中，必须先结束战斗或成功撤退，才能沿路线移动。'));
      return lines.join('\n');
    }
    if (intent.primary === 'combat') {
      const c = context.combat, e = c?.enemy;
      const interrupt = c?.decisions?.interrupt;
      const recommended = c?.decisions?.recommendedAction;
      const effectText = getLang() === 'zh' ? interrupt?.effect?.descriptionZh : interrupt?.effect?.descriptionEn;
      const recommendation = recommended ? recommendedActionText(recommended, c) : interrupt?.effectiveNow && interrupt.canPay ?
        txt('Interrupt now: ', '现在打断：') + (effectText || txt('spend 18 STA to stop this charge or spell.', '消耗18体力，阻止本次蓄力或施法。')) :
        ['heavy', 'charge', 'cast', 'guard'].includes(e?.intent) ? txt('Guard now: reduce damage by 65% and recover 18 STA and 8 MP.', '现在防御：减少65%伤害，恢复18体力与8法力。') :
        txt('Attack, or use an available damaging skill.', '可以攻击，或使用当前可用的伤害技能。');
      lines.push(txt('Recommended action: ', '推荐行动：') + recommendation);
      if (recommended?.kind === 'guard') lines.push(txt('Guard does not restore HP and is not a counterattack.', '防御不恢复生命，也不是反击。'));
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
      if (intent.asksDetails) {
        lines.push(txt('Guard reduces incoming damage by 65%. Interrupt costs 18 STA and stops only a charge or spell.', '防御减少本回合65%伤害。打断消耗18体力，只能阻止蓄力或施法。'));
        lines.push(txt('Skills: ', '技能：') + (c?.skills || []).map(s => `${getLang() === 'zh' ? s.nameZh : s.name}: ${s.cost}${s.pool}, ${s.cooldown} ${txt('turn cooldown', '回合冷却')}, ${s.available ? txt('usable', '可用') : txt('unavailable', '不可用')}`).join('; '));
        lines.push(txt('Supplies: ', '补给：') + (c?.potions || []).map(p => `${p.name} ×${p.count}`).join(', '));
      }
      lines.push(txt('The recommended action spends one player turn. The battle continues afterwards. Explain this action and its listed effect.', '推荐行动会消耗玩家一个回合，随后战斗继续。请解释这项行动及上面列出的效果。'));
      return lines.join('\n');
    }
    if (intent.primary === 'resources') {
      lines.push(`HP ${context.hero.hp}, MP ${context.hero.mp}, STA ${context.hero.stamina}. ${txt('Gold', '金币')}: ${context.hero.gold}.`);
      lines.push(txt('Supplies: ', '补给：') + ((context.combat?.potions || []).map(p => `${p.name} ×${p.count}`).join(', ') || txt('none', '无')));
      if (context.room.safe) lines.push(txt('This is a safe place to rest.', '此处安全，可以完全休息。'));
      return lines.join('\n');
    }
    if (intent.primary === 'memory') {
      const scope = context.npc ? `npc:${context.npc.id}` : 'dm';
      const memories = playerFactsFor(question, scope);
      return [...npcFactsFor(question, context), ...(memories.length ? memories : [txt('No matching permanent player statement is recorded; consult the scoped recent conversation without guessing.', '尚无匹配的长期玩家声明；请参考当前人物的近期对话，不要猜测。')])].join('\n');
    }
    if (context.npc) { lines.push(...npcFactsFor(question, context)); if (intent.primary === 'relationship') return lines.join('\n'); lines.push(txt(`What you know: ${context.npc.lore}`, `你知道的事情：${context.npc.lore}`)); }
    lines.push(txt(`Traveler: ${context.hero.name}, level ${context.hero.level} ${context.hero.class}.`, `旅人：${context.hero.name}，${context.hero.level}级${context.hero.class}。`));
    lines.push(txt(`Current goal: ${context.adventure.objective || context.quest[0]?.description || 'Explore the region.'}`, `当前目标：${context.adventure.objective || context.quest[0]?.description || '探索此区域。'}`));
    if (kind === 'tactics') lines.push(`HP ${context.hero.hp}, MP ${context.hero.mp}, STA ${context.hero.stamina}. ${context.room.safe ? txt('This is a safe place to rest.', '此处安全，可以完全休息。') : txt('Rest fully at a safe settlement.', '完全休息需要返回安全据点。')}`);
    else if (!context.npc && context.adventure.recentJournal?.length) {
      const recent = context.adventure.recentJournal.at(-1);
      lines.push(txt('Recent choice: ', '最近经历：') + `${recent.title}. ${recent.text || ''}`.slice(0, 450));
    }
    return lines.join('\n');
  }

  function rulesReply(question, kind) {
    const started = performance.now(), context = contextFor(question, kind), q = question.toLowerCase(), intent = classifyIntent(question, kind, context);
    const p = state.player;
    let text;
    const route = context.places[0];
    if (intent.primary === 'route') {
      const steps = route.route;
      text = steps === null ? txt('That location is not currently connected to your map.', '该地点暂时没有可到达的路线。') : !steps.length ?
        txt(`You are already at ${route.name}.`, `你已经在【${route.name}】。`) :
        txt(`To reach ${route.name}, follow ${steps.join(' → ')}. Check the danger level before leaving a safe room.`,
          `前往【${route.name}】的路线：${steps.map(d => DIR_ZH[d] || d).join(' → ')}。离开安全区前，请查看目的地危险等级。`);
      if (context.enemy) text += txt(' Finish the battle or successfully flee before travelling.', ' 必须先结束战斗或成功撤退，才能移动。');
    } else if (['combat', 'resources', 'memory', 'encounter', 'relationship'].includes(intent.primary)) {
      text = factsFor(question, kind, context, intent);
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
    if (!canMutate()) return null;
    const question = String(rawQuestion || '').trim().slice(0, 1200);
    if (!question || busy || ['loading', 'connecting'].includes(status)) return null;
    resumeSequence += 1;
    const a = ensureState(), kind = options.kind || 'npc';
    const npcId = WORLD_ROOMS[state.world.currentRoom]?.npcs?.[0]?.id;
    const scope = kind === 'npc' && npcId ? `npc:${npcId}` : 'dm';
    const capturedState = state;
    const event = kind === 'encounter' && typeof GameDirector !== 'undefined' ? GameDirector.getContext().encounter : null;
    mergePlayerFacts(a.knowledge, scope, question);
    a.pendingQuestion = null;
    const entry = { id: newEntryId(), prompt: question, text: '', lang: getLang(),
      source: a.backend === 'wasm_onnx' ? 'wasm' : a.backend === 'local_ollama' ? 'ollama' : 'rules',
      status: 'generating', room: state.world.currentRoom, latencyMs: null, kind, npcId: kind === 'npc' ? npcId || '' : '',
      eventId: event?.id || '', eventToken: event?.token || '',
      runtime: a.backend === 'wasm_onnx' ? registry.runtime : a.backend === 'local_ollama' ? 'Ollama (server version not reported)' : 'game rules',
      revision: a.backend === 'wasm_onnx' ? currentModel().revision : '', dtype: a.backend === 'wasm_onnx' ? currentModel().dtype : '' };
    entry.facts = factsFor(question, kind);
    state.aiLogs.push(entry); if (state.aiLogs.length > 30) state.aiLogs.shift();
    busy = true; activeRequest = entry; setStatus('generating');
    const onChunk = chunk => { if (activeRequest === entry && state === capturedState && window.AethelgardApp?.canWrite?.() !== false) { entry.text += chunk.text || ''; render(); } };
    try {
      let result;
      if (a.backend === 'rules') result = rulesReply(question, kind);
      else {
        const messages = buildMessages(question, kind, scope);
        if (a.backend === 'wasm_onnx') {
          if (!workerReady || workerKey !== `${currentModel().key}:${a.localOnly}`) {
            rememberPending(entry);
            throw new Error(txt('Load the browser model first, or select Rules helper.', '请先点击“下载并加载模型”，或明确选择“规则助手”。'));
          }
          result = await workerJob('generate', { messages, maxNewTokens: options.maxNewTokens }, onChunk, 240000);
        } else result = await ollamaReply(messages, onChunk);
      }
      if (activeRequest !== entry || state !== capturedState || window.AethelgardApp?.canWrite?.() === false) return null;
      // Worker message ids route transport jobs; they are not dialogue ids.
      Object.assign(entry, result, { id: entryId(entry), status: 'complete' });
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
      if (a.backend === 'wasm_onnx' && !workerReady) rememberPending(entry);
      if (a.allowFallback && a.backend !== 'rules') {
        const result = rulesReply(question, kind);
        Object.assign(entry, result, { source: 'rules-fallback', status: 'complete', fallbackReason: entry.error });
        addLog(entry.text, 'ai', 'text-amber-200', entry.text); storeState();
        return { ...result, source: 'rules-fallback', fallbackReason: entry.error };
      }
      storeState();
      return null;
    } finally {
      if (activeRequest === entry) {
        activeRequest = null; busy = false;
        setStatus(entry.status === 'error' ? 'error' : getStatus().ready ? 'ready' : 'unloaded', entry.error || '');
      }
    }
  }

  async function resumeQuestion() {
    if (!canMutate() || busy || ['loading', 'connecting'].includes(status)) return null;
    const saved = ensureState().pendingQuestion;
    if (!saved?.question) return null;
    const capturedState = state, id = normalizedId(saved.id), attempt = ++resumeSequence;
    const stillHere = () => {
      if (attempt !== resumeSequence || state !== capturedState || normalizedId(ensureState().pendingQuestion?.id) !== id) return false;
      if (state.world.currentRoom !== saved.room || (saved.npcId && WORLD_ROOMS[state.world.currentRoom]?.npcs?.[0]?.id !== saved.npcId)) return false;
      if (saved.kind === 'encounter') {
        const event = typeof GameDirector !== 'undefined' ? GameDirector.getContext().encounter : null;
        if (!event || event.id !== saved.eventId || event.token !== saved.eventToken) return false;
      }
      return true;
    };
    if (!stillHere()) {
      const input = document.getElementById('ai-prompt-input'); if (input) input.value = saved.question;
      ensureState().pendingQuestion = null; storeState();
      setStatus(getStatus().ready ? 'ready' : 'unloaded', txt('The scene changed. Your question is in the input; send it again for the current situation.', '场景已经变化。问题已放回输入框，请按当前情况重新提问。'));
      return null;
    }
    if (ensureState().backend === 'wasm_onnx' && !getStatus().ready) await loadBrowserModel();
    else if (ensureState().backend === 'local_ollama' && !getStatus().ready) await connectOllama();
    if (!stillHere() || !getStatus().ready || !canMutate()) return null;
    const input = document.getElementById('ai-prompt-input'); if (input?.value === saved.question) input.value = '';
    const result = await ask(saved.question, { kind: saved.kind });
    if (result && saved.kind === 'encounter' && ['wasm', 'ollama'].includes(result.source)) GameDirector.setNarration(saved.eventId, result.text, result.source, saved.eventToken);
    return result;
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
    if (!canMutate() || busy) return;
    const a = ensureState(); a.memory = {}; a.knowledge = { version: 1, scopes: {} }; a.pendingQuestion = null;
    state.aiLogs = []; lastResult = null; storeState(); render();
  }

  function recordFeedback(index, category = 'facts') {
    if (!canMutate() || !Number.isInteger(index) || !['facts', 'persona', 'scene', 'other'].includes(category)) return false;
    const a = ensureState(), entry = state.aiLogs[index];
    if (!entry || entry.status !== 'complete' || !entry.text) return false;
    const logId = entryId(entry);
    if (a.feedback.some(item => item.entryId === logId && item.category === category)) return true;
    a.feedback.push({ id: `${Date.now()}-${category}-${index}`, entryId: logId, category, recordedAt: new Date().toISOString(),
      prompt: bounded(entry.prompt, 1200), facts: bounded(entry.facts, 4500), answer: bounded(entry.text, 16000),
      source: bounded(entry.source, 40), model: bounded(entry.model, 200), revision: bounded(entry.revision, 80),
      dtype: bounded(entry.dtype, 24), runtime: bounded(entry.runtime, 80), room: bounded(entry.room, 100),
      language: bounded(entry.lang, 8), gameVersion: String(state.version || '') });
    a.feedback = a.feedback.slice(-20); storeState(); render(); return true;
  }
  function feedbackExport() {
    return { format: 'aethelgard-ai-feedback-v1', exportedAt: new Date().toISOString(),
      description: 'Player-reported samples, not adjudicated model failures. Exported locally; no upload.',
      feedback: structuredClone(ensureState().feedback) };
  }
  function downloadFeedback() {
    const data = JSON.stringify(feedbackExport(), null, 2), blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `aethelgard-ai-feedback-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  function clearFeedback() {
    if (!canMutate()) return; ensureState().feedback = []; storeState(); render();
  }

  function resetSession() {
    cancel('', { preserveQuestion: false, persist: false });
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
    const sendButton = document.getElementById('btn-ai-prompt-send'); if (sendButton) sendButton.disabled = busy || ['loading', 'connecting'].includes(status);
    const cancelButton = document.getElementById('ai-cancel'); if (cancelButton) cancelButton.disabled = !busy && !['loading', 'connecting'].includes(status);
    const resume = document.getElementById('ai-resume');
    if (resume) {
      resume.hidden = !a.pendingQuestion; resume.disabled = busy || ['loading', 'connecting'].includes(status);
      resume.textContent = getStatus().ready ? txt('Continue saved question', '继续保留的问题') : txt('Reload and continue', '重新加载并继续');
      resume.title = a.pendingQuestion?.question || '';
    }
    const savedQuestion = document.getElementById('ai-saved-question');
    if (savedQuestion) { savedQuestion.hidden = !a.pendingQuestion; savedQuestion.textContent = a.pendingQuestion ? txt('Saved question: ', '保留的问题：') + bounded(a.pendingQuestion.question, 120) : ''; }
    const browserSettings = document.getElementById('ai-browser-settings'); if (browserSettings) browserSettings.hidden = a.backend !== 'wasm_onnx';
    const ollamaSettings = document.getElementById('ai-ollama-settings'); if (ollamaSettings) ollamaSettings.hidden = a.backend !== 'local_ollama';
    const history = document.getElementById('ai-chat-log');
    if (history) {
      const stickBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 60;
      history.innerHTML = state.aiLogs.length ? state.aiLogs.map((item, index) => {
        const text = item.text || (getLang() === 'zh' ? item.zh : item.en) || '';
        const time = Number.isFinite(item.latencyMs) ? ` · ${(item.latencyMs / 1000).toFixed(2)}s` : '';
        const tokens = Number.isFinite(item.outputTokens) ? ` · ${item.outputTokens} tokens` : '';
        const rate = Number.isFinite(item.tokensPerSecond) ? ` · ${item.tokensPerSecond.toFixed(1)} tok/s` : '';
        const importantFacts = /To reach |No known route|You are already at|Recommended action:|^HP |从这里前往|暂无前往|你已经位于|推荐行动：/m.test(item.facts || '');
        const facts = item.facts ? `<details class="ai-note mb-1" data-authority="game-rules"${importantFacts ? ' open' : ''} style="border-left:2px solid #38bdf8;padding-left:8px"><summary>${txt('Game rules / actual state at the time of this question', '游戏规则 / 提问时的实际状态')}</summary><div class="whitespace-pre-wrap">${esc(item.facts)}</div></details>` : '';
        const originalLabel = ['wasm', 'ollama'].includes(item.source) ? `<div class="ai-note">${txt('Model response · original text', '模型回复 · 原文')}</div>` : '';
        const feedback = item.status === 'complete' && item.text ? `<div class="ai-actions" aria-label="${txt('Record a problem locally', '在本机记录问题')}">${[['facts',txt('Fact error','事实有误')],['persona',txt('Wrong character','角色不一致')],['scene',txt('Scene error','场景不符')]].map(([category,label]) => {
          const reported = a.feedback.some(f => f.entryId === entryId(item) && f.category === category);
          return `<button type="button" class="ai-control" onclick="AethelgardAI.recordFeedback(${index},'${category}')" ${reported ? 'disabled' : ''}>${reported ? '✓ ' : ''}${label}</button>`;
        }).join('')}</div>` : '';
        return `<div class="ai-message" data-source="${esc(item.source)}" data-status="${esc(item.status)}"><div class="text-amber-200 mb-1">${esc(item.prompt)}</div>${facts}${originalLabel}<div class="ai-answer">${esc(text || (item.status === 'generating' ? txt('Thinking…', '正在思考…') : ''))}</div>${item.error ? `<div class="text-rose-300 mt-1">${esc(item.error)}</div>` : ''}<div class="ai-meta">${esc(sourceLabel(item.source))}${item.model ? ' · ' + esc(String(item.model).split('/').pop()) : ''}${time}${tokens}${rate}</div>${feedback}</div>`;
      }).join('') : `<div class="ai-note p-2">${txt('Load a local model to begin a conversation. Ask about your journey, speak to an NPC, or request a tactical explanation.', '加载本地模型即可开始对话。可以询问旅程、与 NPC 交谈，或请智脑解释战术。')}</div>`;
      if (stickBottom) history.scrollTop = history.scrollHeight;
    }
    const notes = document.getElementById('ai-memory-card');
    if (notes) {
      const npc = WORLD_ROOMS[state.world.currentRoom]?.npcs?.[0], scope = npc ? `npc:${npc.id}` : 'dm';
      const facts = a.knowledge.scopes[scope] || [];
      notes.textContent = facts.length ? txt('Player statements remembered here:\n', '此处记住的玩家声明：\n') + facts.map(f => f.text).join('\n') :
        txt('Tell this character a name (“My sister is named Mira”) or a promise (“I promise to find the courier”). These notes survive short chat history. They do not complete quests.', '可以明确告诉当前人物姓名（“我的姐姐叫米拉”）或承诺（“我承诺寻找信使”）。这些记录可在短对话结束后保留，不会自动完成任务。');
    }
    const feedbackCount = document.getElementById('ai-feedback-count'); if (feedbackCount) feedbackCount.textContent = txt(`${a.feedback.length} local reports. Export includes questions, game facts and original answers. Nothing is uploaded.`, `已记录 ${a.feedback.length} 条本机反馈。导出包含问题、当时事实与原文，不会自动上传。`);
    const exportButton = document.getElementById('ai-feedback-export'); if (exportButton) exportButton.disabled = !a.feedback.length;
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
      <form id="ai-prompt-form" onsubmit="handleAiPromptSubmit(event)" class="flex gap-1"><input id="ai-prompt-input" maxlength="1200" value="${esc(a.pendingQuestion?.question || '')}" class="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2" aria-label="${txt('Ask your DM', '向智脑提问')}" placeholder="${txt('How do I reach the tavern?', '我该怎样前往酒馆？')}"><button id="btn-ai-prompt-send" class="ai-control ai-primary" type="submit">${txt('Ask', '提问')}</button></form>
      <div id="ai-saved-question" class="ai-note" hidden></div><div class="ai-actions"><button id="ai-cancel" class="ai-control" onclick="AethelgardAI.cancel()">${txt('Stop', '停止')}</button><button id="ai-resume" class="ai-control ai-primary" onclick="AethelgardAI.resumeQuestion()" hidden>${txt('Reload and continue', '重新加载并继续')}</button><button class="ai-control" onclick="AethelgardAI.clearMemory()">${txt('Clear dialogue memory', '清除对话记忆')}</button></div>
      <details class="ai-note"><summary>${txt('Remembered names and promises', '记住的人物与承诺')}</summary><p id="ai-memory-card" class="whitespace-pre-wrap"></p></details>
      <details class="ai-note"><summary>${txt('Answer feedback', '回答反馈')}</summary><p id="ai-feedback-count"></p><div class="ai-actions"><button id="ai-feedback-export" class="ai-control" onclick="AethelgardAI.downloadFeedback()">${txt('Export reports', '导出反馈')}</button><button class="ai-control" onclick="AethelgardAI.clearFeedback()">${txt('Clear reports', '清除反馈')}</button></div></details>
      <details class="ai-note"><summary>${txt('Inference evidence', '推理运行记录')}</summary><pre id="ai-diagnostics" class="whitespace-pre-wrap break-all text-[10px]"></pre><p>${txt('Narration never changes rewards or combat outcomes; your choices are resolved by game rules.', '叙事不会自行发放奖励或改变战斗结果；你的选择由游戏规则结算。')}</p></details>`;
    render();
  }

  return { ensureState, getStatus, getDiagnostics: getStatus, selectBackend, updateSettings,
    loadBrowserModel, connectOllama, ask, cancel, resumeQuestion, resetSession, clearMemory, narrateEncounter, mount, render,
    buildMessages, contextFor, factsFor, rulesReply, classifyIntent, rememberPlayerStatement, playerFactsFor,
    recordFeedback, feedbackExport, downloadFeedback, clearFeedback, findRoute, endpoint, verifyOfflinePackage };
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
  if (!input || !input.value.trim() || AethelgardAI.getStatus().busy || ['loading', 'connecting'].includes(AethelgardAI.getStatus().status) || window.AethelgardApp?.canWrite?.() === false) return;
  const q = input.value.trim(); input.value = ''; return askNpcAi(q);
}
