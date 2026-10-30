// ═══════════════════════════════════════════════════════════════
// SpotMe Caching · Service Worker
//
// Versionierung: CACHE_VERSION bei jedem Deploy hochzählen.
// Der Browser erkennt den neuen SW, löscht den alten Cache
// und installiert die neuen Dateien automatisch.
// ════════════════════════════════════════════════════════════
const CACHE_VERSION = "v395.6"; // Erhöht für SW-Update
const CACHE_STATIC = `spotme-caching-${CACHE_VERSION}`;
const CACHE_API = `spotme-api-${CACHE_VERSION}`;
const CACHE_TILES = `spotme-map-tiles-${CACHE_VERSION}`;

// Max. Anzahl der zu speichernden Kartenkacheln
// Schützt vor Speicherüberlauf. Pro Kachel ca. 10-50 KB.
const MAX_TILE_CACHE_ITEMS = 1500;

// Alle Dateien die offline verfügbar sein müssen.
// Schlägt eine Datei fehl, wird sie übersprungen (kein Totalausfall).
const STATIC_ASSETS = [
  "/",
  "nav.js",
  "/index.html",
  "/live-spot-manage.html",
  "/live-spot.html",
  "/spotme.css",
  "/theme-vars.css",
  "/help/help.css",
  "/spot-woche.html",
  "/spot-navi.html",
  "/help/treffen.html",
  "/help/chat.html",
  "/help/alle-spots.html",
  "/help/neue-spots.html",
  "/help/push.html",
  "/help/meine-spots.html",
  "/help/radius-suche.html",
  "/help/navigation.html",
  "/help/waypoints.html",
  "/help/kategorien.html",
  "/help/einladungen.html",
  "/help/wochen-spots.html",
  "/waypoints.html",
  "/waypoint-creator.html",
  "/profil-caching.html",
  "/landing.html",
  "/404.html",
  "/manifest.json",
  "/bluesky.js",
  "https://unpkg.com/lucide@0.383.0/dist/umd/lucide.min.js",
  // MapLibre GL JS Bibliothek wird jetzt auch statisch gecacht
  "https://unpkg.com/maplibre-gl@4.1.2/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@4.1.2/dist/maplibre-gl.css"
];

// API-Antworten maximal so lange im Cache behalten (in Sekunden).
// Verhindert unbegrenztes Cache-Wachstum.
const API_CACHE_MAX_AGE = 60;

// ── INSTALLATION ─────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_STATIC)
      .then((cache) => {
        // Promise.allSettled statt addAll: einzelne Fehler
        // brechen die Installation nicht ab.
        return Promise.allSettled(
          STATIC_ASSETS.map((url) =>
            cache
              .add(url)
              .catch((err) =>
                console.warn(`[SW] Konnte nicht cachen: ${url}`, err),
              ),
          ),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

// ── AKTIVIERUNG ──────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== CACHE_STATIC &&
                key !== CACHE_API &&
                key !== CACHE_TILES,
            )
            .map((key) => {
              console.log(`[SW] Alter Cache gelöscht: ${key}`);
              return caches.delete(key);
            }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── HILFSFUNKTION FÜR KACHEL-CACHE-GRÖSSE ────────────────────────
async function limitTileCacheSize() {
  const cache = await caches.open(CACHE_TILES);
  const keys = await cache.keys();
  if (keys.length > MAX_TILE_CACHE_ITEMS) {
    const toDelete = keys.slice(0, keys.length - MAX_TILE_CACHE_ITEMS);
    await Promise.all(toDelete.map((request) => cache.delete(request)));
    console.log(
      `[SW] Alte Kacheln gelöscht, Cache-Größe auf ${MAX_TILE_CACHE_ITEMS} begrenzt.`,
    );
  }
}

// ── FETCH ────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Nur GET-Requests cachen — POST/PUT/DELETE immer ans Netz.
  if (request.method !== "GET") return;

  // Externe Domains, die wir nicht cachen wollen.
  if (
    url.origin !== self.location.origin &&
    //     !url.hostname.includes('fonts.googleapis') &&
    //     !url.hostname.includes('fonts.gstatic') &&
    !url.hostname.includes("unpkg.com") &&
    !url.hostname.includes("openfreemap.org")
  ) {
    return;
  }

  // ── API-Calls: Network First ──────────────────────────────────
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request.clone())
        .then((response) => {
          if (!response.ok) return response;
          const clone = response.clone();
          caches.open(CACHE_API).then((cache) => {
            const headers = new Headers(clone.headers);
            headers.append("sw-cached-at", Date.now().toString());
            clone.blob().then((body) =>
              cache.put(
                request,
                new Response(body, {
                  status: clone.status,
                  statusText: clone.statusText,
                  headers,
                }),
              ),
            );
          });
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (!cached)
            return new Response(
              JSON.stringify({ error: "Offline – keine gecachten Daten" }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            );
          const cachedAt = parseInt(cached.headers.get("sw-cached-at") || "0");
          const ageSeconds = (Date.now() - cachedAt) / 1000;
          if (ageSeconds > API_CACHE_MAX_AGE) {
            return new Response(
              JSON.stringify({ error: "Offline – Cache zu alt" }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            );
          }
          return cached;
        }),
    );
    return;
  }

// ── NEWS TEASER: Network First ─────────────────────────────────
// Immer aktuellen Content holen, Cache nur als Offline-Fallback.
if (url.pathname.endsWith("/news.md")) {
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_STATIC).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
  return;
}

  // ── STATISCHE DATEIEN: Cache First ────────────────────────────
  if (
    url.origin === self.location.origin ||
    url.hostname.includes("unpkg.com")
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              caches
                .open(CACHE_STATIC)
                .then((cache) => cache.put(request, response.clone()));
            }
            return response;
          })
          .catch(() => caches.match("/404.html"));
      }),
    );
    return;
  }

  // ── KARTEN-KACHELN (openfreemap): Stale-While-Revalidate ───────
  if (url.hostname.includes("openfreemap.org")) {
    event.respondWith(
      caches.open(CACHE_TILES).then(async (cache) => {
        const cachedResponse = await cache.match(request);
        const fetchPromise = fetch(request)
          .then(async (networkResponse) => {
            if (networkResponse.ok) {
              await cache.put(request, networkResponse.clone());
              // Begrenze die Cache-Größe im Hintergrund
              limitTileCacheSize().catch(console.warn);
            }
            return networkResponse;
          })
          .catch(() => undefined);
        if (cachedResponse) {
          event.waitUntil(fetchPromise);
          return cachedResponse;
        }
        const fresh = await fetchPromise;
        if (fresh) return fresh;
        return new Response("Offline – Kachel nicht verfügbar", {
          status: 404,
        });
      }),
    );
    return;
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { title: "SpotMe", body: event.data?.text() || "" };
  }

  const options = {
    body: data.body || "",
    icon: "/icons/pwa_192.png",
    badge: "/icons/pwa_72.png",
    data: { url: data.url || "/" },
    vibrate: [200, 100, 200],
    tag: data.tag || "spotme",
    renotify: true,
    silent: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "SpotMe", options),
  );
});

// Tippen auf die Notification → App öffnen / fokussieren
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.focus();
            client.postMessage({ type: "PUSH_NAVIGATE", url });
            return;
          }
        }
        if (clients.openWindow) return clients.openWindow(url);
      }),
  );
});
