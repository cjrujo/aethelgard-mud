/* Offline shell and pinned runtime. Transformers.js owns its model weight cache. */
const CACHE = 'aethelgard-shell-6c661de50a5bddf1';
const RUNTIME = 'aethelgard-runtime-transformers-3.8.1';
const SHELL = ['./', 'index.html', 'open_world_mud.html', 'assets/game.css', 'assets/ai-worker.js', 'models/registry.json'];
self.addEventListener('install', event => {
  // A running hero keeps a coherent shell until they choose Save and update.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('aethelgard-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET') return;
  // Never cache local Ollama responses, chat, model weights twice, or credentials.
  const sameOrigin = url.origin === self.location.origin;
  const pinnedRuntime = url.origin === 'https://cdn.jsdelivr.net' &&
    (url.pathname.startsWith('/npm/@huggingface/transformers@3.8.1') || url.pathname.startsWith('/npm/onnxruntime-web@'));
  const shellUrl = sameOrigin && SHELL.some(file => new URL(file, self.registration.scope).pathname === url.pathname);
  if (!shellUrl && !pinnedRuntime) return;
  event.respondWith((async () => {
    const cache = await caches.open(pinnedRuntime ? RUNTIME : CACHE);
    const shellKey = new URL(url); shellKey.search = ''; shellKey.hash = '';
    const cacheKey = shellUrl ? shellKey.href : request;
    const stored = await cache.match(cacheKey);
    if (stored) return stored;
    try {
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque') await cache.put(cacheKey, response.clone());
      return response;
    } catch (error) {
      const stored = await cache.match(cacheKey);
      if (stored) return stored;
      if (request.mode === 'navigate') {
        const index = await cache.match(new URL('index.html', self.registration.scope));
        if (index) return index;
      }
      throw error;
    }
  })());
});
