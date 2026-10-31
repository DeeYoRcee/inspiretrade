const CACHE_NAME = "trading-journal-v4";
const APP_SHELL = ["/", "/index.html", "/favicon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);

  // This service worker should only cache this app's own resources.
  if (url.origin !== self.location.origin) {
    return;
  }

  // The worker and document must be revalidated after every publish.
  if (
    url.pathname === "/sw.js" ||
    event.request.mode === "navigate" ||
    event.request.headers.get("accept")?.includes("text/html")
  ) {
    event.respondWith(
      fetch(new Request(event.request, { cache: "no-store" }))
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put("/index.html", copy);
            });
          }
          return response;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // API requests must never be served from the app shell cache.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Vite production assets are content-hashed, so cache-first is safe.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, copy);
            });
          }
          return response;
        });
      }),
    );
    return;
  }

  // Other static resources prefer fresh content but remain available offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, copy);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});