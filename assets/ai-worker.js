/* Actual local Transformers.js inference. No scripted replies or cloud chat API.
 * Reconstructed after recovery of the PC snapshot; tests distinguish protocol
 * doubles from genuine model runs. The page cancels by terminating this worker.
 */
const RUNTIME_VERSION = '@huggingface/transformers@3.8.1';
const RUNTIME_ROOT = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';

export function createWorkerController({
  postMessage = message => self.postMessage(message),
  importModule = url => import(url),
  now = () => performance.now(),
  cacheApi = typeof caches === 'undefined' ? null : caches
} = {}) {
  let generator = null, activeModel = null, runtime = null, busy = false;
  const emit = (id, type, fields = {}) => postMessage({ id, type, ...fields });

  function validateConfig(config) {
    const model = config?.model;
    if (!model || !/^[\w.-]+\/[\w.-]+$/.test(model.id) || !/^[a-f0-9]{40}$/i.test(model.revision)) {
      throw new Error('A model id and immutable 40-character revision are required.');
    }
    if (!['q8', 'q4', 'q4f16', 'fp32', 'fp16', 'int8', 'uint8', 'bnb4'].includes(model.dtype)) throw new Error('Unsupported model dtype.');
    if (config.runtimeVersion !== RUNTIME_VERSION) throw new Error('Inference runtime version does not match this game.');
    const base = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Serve the game over HTTP or HTTPS before loading the model.');
    const localOnly = config.localOnly === true;
    const runtimeUrl = localOnly ? new URL('vendor/transformers.min.js', base).href : `${RUNTIME_ROOT}transformers.min.js`;
    if (config.runtimeUrl !== runtimeUrl) throw new Error('Unexpected inference runtime URL.');
    return { model, base, localOnly, runtimeUrl };
  }

  async function load(id, config) {
    const { model, base, localOnly, runtimeUrl } = validateConfig(config);
    const started = now();
    if (generator) await generator.dispose();
    generator = null; activeModel = null;
    runtime = await importModule(runtimeUrl);
    const { env, pipeline, TextStreamer } = runtime;
    if (env?.version !== '3.8.1' || typeof pipeline !== 'function' || typeof TextStreamer !== 'function') {
      throw new Error('The loaded runtime is not Transformers.js 3.8.1.');
    }
    env.allowRemoteModels = !localOnly;
    env.allowLocalModels = localOnly;
    env.localModelPath = new URL('models/', base).href;
    env.remoteHost = 'https://huggingface.co/';
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    env.useFS = false; env.useFSCache = false;
    // CacheStorage is unavailable on many HTTP preview origins. Inference can
    // still work there, but the page reports that persistent caching is absent.
    let cacheEnabled = false;
    if (cacheApi?.open) {
      try { await cacheApi.open('transformers-cache'); cacheEnabled = true; } catch (_) { /* No silent model fallback. */ }
    }
    env.useBrowserCache = cacheEnabled;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.wasmPaths = localOnly ? new URL('vendor/', base).href : RUNTIME_ROOT;
    const loaded = await pipeline('text-generation', model.id, {
      dtype: model.dtype, device: 'wasm', revision: model.revision,
      local_files_only: localOnly,
      progress_callback: progress => emit(id, 'progress', { progress })
    });
    if (!loaded?.tokenizer || typeof loaded !== 'function') throw new Error('The local model did not initialize a text-generation pipeline.');
    generator = loaded; activeModel = { ...model };
    emit(id, 'ready', { model: model.id, revision: model.revision, dtype: model.dtype,
      device: 'wasm', source: 'wasm', cacheEnabled, localOnly, loadMs: now() - started });
  }

  function promptWithinBudget(messages) {
    if (!Array.isArray(messages) || messages.length < 2 || messages[0]?.role !== 'system' || messages.at(-1)?.role !== 'user') {
      throw new Error('A system prompt and latest user question are required.');
    }
    let selected = messages.map(message => {
      if (!['system', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string') throw new Error('Malformed conversation message.');
      return { role: message.role, content: message.content };
    });
    const initialCount = selected.length;
    const budget = Math.max(256, Math.min(4096, Number(activeModel.contextBudget) || 1600));
    for (;;) {
      const prompt = generator.tokenizer.apply_chat_template(selected, {
        tokenize: false, add_generation_prompt: true, ...(activeModel.chatTemplateOptions || {})
      });
      const encoded = generator.tokenizer(prompt, { add_special_tokens: false, truncation: false });
      const inputTokens = encoded.input_ids?.data?.length ?? encoded.input_ids?.size;
      if (!Number.isInteger(inputTokens) || inputTokens < 1) throw new Error('Could not measure actual input tokens.');
      if (inputTokens <= budget) return { prompt, inputTokens, droppedMessages: initialCount - selected.length };
      if (selected.length <= 2) throw new Error('The current game facts and question exceed the local model context budget. Ask a shorter question.');
      // Keep the system role and latest factual question intact. Remove the
      // oldest dialogue turn, never silently truncate the authoritative facts.
      selected.splice(1, selected[1]?.role === 'user' && selected[2]?.role === 'assistant' ? 2 : 1);
    }
  }

  async function generate(id, messages, requestedTokens) {
    if (!generator || !activeModel) throw new Error('Load the local model before asking a question.');
    const { prompt, inputTokens, droppedMessages } = promptWithinBudget(messages);
    const maximum = Math.max(1, Math.min(256, Number(activeModel.maxNewTokens) || 128));
    const maxNewTokens = Number.isFinite(requestedTokens) ? Math.max(1, Math.min(maximum, Math.floor(requestedTokens))) : maximum;
    const started = now();
    let outputTokens = 0, firstTokenMs = null;
    const streamer = new runtime.TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      token_callback_function: tokens => {
        outputTokens += tokens.length;
        if (tokens.length && firstTokenMs === null) firstTokenMs = now() - started;
      },
      callback_function: text => { if (text) emit(id, 'chunk', { text }); }
    });
    const result = await generator(prompt, {
      max_new_tokens: maxNewTokens, do_sample: false, repetition_penalty: 1.0,
      add_special_tokens: false, return_full_text: false, streamer
    });
    const text = result?.[0]?.generated_text;
    if (typeof text !== 'string' || !text.trim() || outputTokens < 1) throw new Error('The local model returned no completed answer.');
    const latencyMs = now() - started;
    emit(id, 'complete', { text: text.trim(), source: 'wasm', model: activeModel.id,
      revision: activeModel.revision, dtype: activeModel.dtype, device: 'wasm',
      inputTokens, outputTokens, firstTokenMs, latencyMs,
      tokensPerSecond: latencyMs > 0 ? outputTokens / (latencyMs / 1000) : null,
      droppedMessages, generation: { maxNewTokens, doSample: false, repetitionPenalty: 1.0 } });
  }

  async function handle(message) {
    const { id, type } = message || {};
    if (!Number.isSafeInteger(id) || id < 1) return;
    if (busy) { emit(id, 'error', { message: 'The model is busy. Wait for the current operation or stop it first.' }); return; }
    busy = true;
    try {
      if (type === 'load') await load(id, message.config);
      else if (type === 'generate') await generate(id, message.messages, message.maxNewTokens);
      else throw new Error('Unknown worker operation.');
    } catch (error) {
      emit(id, 'error', { message: String(error?.message || error).slice(0, 1200) });
    } finally { busy = false; }
  }
  return { handle, async dispose() { if (generator) await generator.dispose(); generator = null; activeModel = null; } };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const controller = createWorkerController();
  self.onmessage = event => { void controller.handle(event.data); };
}
