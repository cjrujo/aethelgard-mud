/* Offline shell and pinned runtime. Transformers.js owns its model weight cache. */
const CACHE = 'aethelgard-shell-ba621988e6d47281';
const RUNTIME = 'aethelgard-runtime-transformers-3.8.1';
const SHELL = ['./', 'index.html', 'open_world_mud.html', 'assets/game.css', 'assets/ai-worker.js', 'models/registry.json'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
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
  const shellUrl = sameOrigin && SHELL.some(file => new URL(file, self.registration.scope).href === url.href);
  if (!shellUrl && !pinnedRuntime) return;
  event.respondWith((async () => {
    const cache = await caches.open(pinnedRuntime ? RUNTIME : CACHE);
    if (pinnedRuntime) {
      const stored = await cache.match(request); if (stored) return stored;
    }
    try {
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const stored = await cache.match(request);
      if (stored) return stored;
      if (request.mode === 'navigate') {
        const index = await cache.match(new URL('index.html', self.registration.scope));
        if (index) return index;
      }
      throw error;
    }
  })());
});
