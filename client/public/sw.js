const CACHE_NAME = "inspiretrade-v8";
const APP_SHELL = ["/", "/index.html", "/favicon.png"];
// the alert state lives in its own cache so the background sync can diff
// fresh news/calendar events even when every tab of the site is closed
const ALERT_STATE_CACHE = "inspire-alert-state-v1";
const ALERT_STATE_URL = "/__inspire-alert-state__";

async function readAlertState() {
  try {
    const cache = await caches.open(ALERT_STATE_CACHE);
    const res = await cache.match(ALERT_STATE_URL);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

async function writeAlertState(state) {
  try {
    const cache = await caches.open(ALERT_STATE_CACHE);
    await cache.put(
      ALERT_STATE_URL,
      new Response(JSON.stringify(state), { headers: { "content-type": "application/json" } }),
    );
  } catch {
    /* private mode / quota — background alerts degrade silently */
  }
}

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
    return;
  }
  // the page mirrors its alert settings + seen markers here on every change
  if (event.data?.type === "ALERT_STATE" && event.data.state) {
    event.waitUntil(writeAlertState(event.data.state));
  }
});

// ---- background news/calendar check (installed PWA, Chromium) ------------
// Chrome periodically wakes the worker even with the site closed; the same
// rules as the in-tab AlertsEngine apply (user symbols, fresh items only).
self.addEventListener("periodicsync", (event) => {
  if (event.tag !== "inspire-news") return;
  event.waitUntil(checkNewsInBackground());
});

async function checkNewsInBackground() {
  const state = await readAlertState();
  const settings = state?.settings;
  if (!settings || !settings.enabled || !Array.isArray(settings.symbols) || settings.symbols.length === 0) return;
  try {
    const lang = state.language && state.language !== "en" ? `?lang=${encodeURIComponent(state.language)}` : "";
    const res = await fetch(`/api/news${lang}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const items = data.items ?? [];
    const seen = new Set(state.newsSeen ?? []);
    const fresh = items
      .filter(
        (i) =>
          !seen.has(i.link) &&
          Date.now() - i.publishedAt < 60 * 60 * 1000 &&
          Array.isArray(i.symbols) &&
          i.symbols.some((s) => settings.symbols.includes(s)),
      )
      .slice(0, 3);
    for (const item of fresh) {
      await self.registration.showNotification(
        item.symbols.filter((s) => settings.symbols.includes(s)).join(" · ") || "News",
        { body: String(item.title || "").slice(0, 180), tag: item.link, icon: "/favicon.png", data: { url: "/news" } },
      );
      seen.add(item.link);
    }
    if (fresh.length) {
      state.newsSeen = [...seen].slice(-600);
      await writeAlertState(state);
    }

    // calendar — high-impact events starting within 30 minutes
    const calSeen = new Set(state.calSeen ?? []);
    if (settings.calEnabled && data.calendarOk && Array.isArray(data.calendar) && settings.calCurrencies?.length) {
      const soon = data.calendar
        .filter(
          (e) =>
            e.impact === "High" &&
            settings.calCurrencies.includes(e.currency) &&
            !calSeen.has(e.id) &&
            e.date > Date.now() &&
            e.date - Date.now() <= 30 * 60 * 1000,
        )
        .slice(0, 2);
      for (const ev of soon) {
        const mins = Math.max(1, Math.round((ev.date - Date.now()) / 60000));
        await self.registration.showNotification(`${ev.currency} — ${mins} min`, {
          body: String(ev.title || "").slice(0, 180),
          tag: ev.id,
          icon: "/favicon.png",
          data: { url: "/" },
        });
        calSeen.add(ev.id);
      }
      if (soon.length) {
        state.calSeen = [...calSeen].slice(-200);
        await writeAlertState(state);
      }
    }
  } catch {
    /* offline — the next wake retries */
  }
}

// ---- web push (server cron → browser notification while the site is closed)
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "InspireTrade", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      // P64R2 — user report: alerts arrived from BOTH "Google Chrome" and the
      // installed InspireTrade app (the tab and the PWA each hold their own
      // push subscription). If any of our windows is open and visible, deliver
      // the message IN-PAGE (one toast) and skip the OS notification.
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = clientList.filter((c) => c.visibilityState === "visible");
      if (visible.length) {
        for (const client of visible) {
          client.postMessage({ type: "it-push-alert", data });
        }
        return;
      }
      await self.registration.showNotification(String(data.title || "InspireTrade"), {
        body: String(data.body || "").slice(0, 200),
        tag: data.tag,
        icon: "/icon-192.png",
        badge: "/favicon-32.png",
        data: { url: data.url || "/" },
      });
    })(),
  );
});

// clicking a notification focuses the site (or opens it)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
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