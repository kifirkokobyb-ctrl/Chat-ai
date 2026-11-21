const SHELL_CACHE = "smollm-pwa-shell-v2";
const MODEL_CACHE = "smollm2-model-cache-v3";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![SHELL_CACHE, MODEL_CACHE].includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/model-files/")) {
    event.respondWith((async () => {
      const cache = await caches.open(MODEL_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      return new Response("Файл модели ещё не скачан. Подключись к интернету и нажми «Скачать SmolLM2».", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    })());
    return;
  }

  // Keep the app shell and Vite-built scripts/styles available after first online visit.
  if (url.pathname === "/" || /\.(?:js|css|webmanifest|png|svg|woff2?)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(req);
        if (response.ok) {
          try { await cache.put(req, response.clone()); } catch {}
        }
        return response;
      } catch {
        return (await cache.match(req)) || (url.pathname === "/" ? await cache.match("/") : Response.error());
      }
    })());
  }
});
