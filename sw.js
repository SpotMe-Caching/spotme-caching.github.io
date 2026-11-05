// ═══════════════════════════════════════════════════════════════
// SpotMe Caching · Service Worker
//
// Versionierung: CACHE_VERSION bei jedem Deploy hochzählen.
// Der Browser erkennt den neuen SW, löscht den alten Cache
// und installiert die neuen Dateien automatisch.
// ════════════════════════════════════════════════════════════
const CACHE_VERSION = "v397.6"; // Erhöht für SW-Update
const CACHE_STATIC = `spotme-caching-${CACHE_VERSION}`;
const CACHE_API = `spotme-api-${CACHE_VERSION}`;
// Karten-Cache: FESTER Name – überlebt Updates (kein Versions-Suffix!).
// Enthält Kacheln, Kartenstil, Symbole und Schriften von OpenFreeMap.
const CACHE_MAP = "spotme-map-persist";
const MAX_MAP_ENTRIES = 5000;            // Kacheln ca. 10–50 KB → grob 100–250 MB
const TILE_TTL_MS  = 30 * 24 * 3600e3;   // Kacheln/Symbole/Schriften: 30 Tage ohne Netz-Anfrage
const META_TTL_MS  = 24 * 3600e3;        // Kartenstil + TileJSON: täglich prüfen (enthält die Kachel-Version)

// Alle Dateien die offline verfügbar sein müssen.
// Schlägt eine Datei fehl, wird sie übersprungen (kein Totalausfall).
const STATIC_ASSETS = [
  "/",
  "nav.js",
  "/index.html",
  "/live-spot-manage.html",
  "/live-spot.html",
  "/spot.html",
  "/live-events-client.js",
  "/chat-core.js",
  "/spot-outbox.js",
  "/benachrichtigungen.html",
  "/spotme.css",
  "/theme-vars.css",
  "/help/help.css",
  "/spot-woche.html",
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
    migrateOldTileCaches()
      .catch((e) => console.warn("[SW] Karten-Migration:", e))
      .then(() => caches.keys())
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== CACHE_STATIC &&
                key !== CACHE_API &&
                key !== CACHE_MAP,
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

// ── KARTEN-CACHE (dauerhaft) ─────────────────────────────────────
// Eintrag mit Zeitstempel versehen (für die Frische-Prüfung).
// content-encoding/-length entfernen: der Body ist schon dekodiert.
async function stampResponse(resp) {
  const h = new Headers(resp.headers);
  h.delete("content-encoding");
  h.delete("content-length");
  h.set("x-sw-cached-at", String(Date.now()));
  const body = await resp.blob();
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// Alte, versionierte Kachel-Caches (spotme-map-tiles-vXXX) einmalig in den festen Cache übernehmen
async function migrateOldTileCaches() {
  const old = (await caches.keys()).filter((k) => k.startsWith("spotme-map-tiles-"));
  if (!old.length) return;
  const dest = await caches.open(CACHE_MAP);
  for (const k of old) {
    const c = await caches.open(k);
    for (const req of await c.keys()) {
      if (await dest.match(req)) continue;
      const r = await c.match(req);
      if (r && r.ok) await dest.put(req, await stampResponse(r));
    }
    await caches.delete(k);
  }
  console.log("[SW] Alte Kartenkacheln übernommen");
}

// Älteste Einträge entfernen – nicht bei jedem Schreibzugriff, sondern gesammelt
let mapPutsSinceTrim = 0;
function scheduleMapTrim() {
  if (++mapPutsSinceTrim < 40) return;
  mapPutsSinceTrim = 0;
  trimMapCache().catch(() => {});
}
async function trimMapCache() {
  const cache = await caches.open(CACHE_MAP);
  const keys = await cache.keys();
  if (keys.length <= MAX_MAP_ENTRIES) return;
  const drop = keys.length - Math.floor(MAX_MAP_ENTRIES * 0.9); // 10 % Luft
  await Promise.all(keys.slice(0, drop).map((r) => cache.delete(r)));
  console.log(`[SW] Karten-Cache auf ${MAX_MAP_ENTRIES} Einträge begrenzt`);
}

function mapKind(url) {
  const p = url.pathname;
  if (p.startsWith("/fonts/") || p.startsWith("/sprites/")) return "asset"; // Schriften, Symbole
  if (p.startsWith("/styles/") || p === "/planet") return "meta";           // Stil, TileJSON
  return "tile";
}

// Cache zuerst. Nur wenn der Eintrag zu alt ist, wird nachgeladen
// (Kartenstil: kurz warten, sonst Cache; Kacheln: im Hintergrund).
async function handleMapRequest(event, request, kind) {
  const cache = await caches.open(CACHE_MAP);
  const cached = await cache.match(request);
  const age = cached ? Date.now() - Number(cached.headers.get("x-sw-cached-at") || 0) : Infinity;
  const ttl = kind === "meta" ? META_TTL_MS : TILE_TTL_MS;

  const refresh = async () => {
    const net = await fetch(request);
    if (net && net.ok) {
      event.waitUntil(
        stampResponse(net.clone()).then((r) => cache.put(request, r)).then(scheduleMapTrim).catch(() => {}),
      );
    }
    return net;
  };

  if (cached && age < ttl) return cached;

  if (cached) {
    if (kind === "meta") {
      try {
        return await Promise.race([
          refresh(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
        ]);
      } catch { return cached; }
    }
    event.waitUntil(refresh().catch(() => {}));
    return cached;
  }

  try {
    return await refresh();
  } catch {
    return new Response("Offline – Karte nicht verfügbar", { status: kind === "tile" ? 404 : 503 });
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

  // ── KARTE (openfreemap): dauerhaft zwischengespeichert, Cache zuerst ──
  if (url.hostname.includes("openfreemap.org")) {
    event.respondWith(handleMapRequest(event, request, mapKind(url)));
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
