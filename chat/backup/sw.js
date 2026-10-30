// ══════════════════════════════════════════════════════════════════════════════
// SPOTME CHAT · Service Worker
//
// Eigenständiger SW für die Chat-PWA.
// Getrennt vom SpotMe Caching SW (sw.js im Root) – eigene Cache-Version,
// eigene Assets, eigene Lifecycle.
//
// Strategien:
//   • Statische Chat-Dateien  → Cache First (sofort offline)
//   • API-Antworten           → Network First (immer frisch, Fallback: Cache)
//   • Externe Ressourcen      → Stale-While-Revalidate
// ══════════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = "spot-v1.22.5";
const CACHE_STATIC = `spot-static-${CACHE_VERSION}`;
const CACHE_API = `spot-api-${CACHE_VERSION}`;
const CACHE_RUNTIME = `spot-runtime-${CACHE_VERSION}`;

// ── STATISCHE ASSETS – werden bei Installation gecacht ──────────────────────
const STATIC_ASSETS = [
  "/chat/",
  "/chat/icons/",
  "/chat/messenger.css",
  "/chat/webrtc.js",
  "/chat/index.html",
  "/chat/manifest.json",
  // Fonts (optional – falls du Google Fonts nutzt)
  "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap",
  // Lucide Icons (falls im Chat genutzt)
  "https://unpkg.com/lucide@0.383.0/dist/umd/lucide.min.js",
];

// API-Cache maximales Alter in Sekunden
const API_CACHE_MAX_AGE = 30; // 30 Sekunden – Chat soll frisch sein

// Maximale Anzahl Runtime-Cache-Einträge
const MAX_RUNTIME_ENTRIES = 50;

// ══════════════════════════════════════════════════════════════════════════════
// INSTALLATION
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener("install", (event) => {
  console.log(`[Chat SW] Installiere ${CACHE_VERSION}`);
  event.waitUntil(
    caches
      .open(CACHE_STATIC)
      .then((cache) => {
        // allSettled: einzelne Fehler brechen nicht alles ab
        return Promise.allSettled(
          STATIC_ASSETS.map((url) =>
            cache
              .add(url)
              .catch((err) =>
                console.warn(`[Chat SW] Konnte nicht cachen: ${url}`, err),
              ),
          ),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// AKTIVIERUNG – alte Caches löschen
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener("activate", (event) => {
  console.log(`[Chat SW] Aktiviere ${CACHE_VERSION}`);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("spot-static-") ||
                key.startsWith("spot-api-") ||
                key.startsWith("spot-runtime-"),
            )
            .filter(
              (key) =>
                key !== CACHE_STATIC &&
                key !== CACHE_API &&
                key !== CACHE_RUNTIME,
            )
            .map((key) => {
              console.log(`[Chat SW] Alter Cache gelöscht: ${key}`);
              return caches.delete(key);
            }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// FETCH – Routing je nach Request-Typ
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Nur GET cachen – POST/PUT/DELETE immer ans Netz
  if (request.method !== "GET") return;

  // ── 1. API-CALLS: Network First (mit Cache-Fallback) ──────────────────────
  // Chat-API muss möglichst frisch sein, aber offline nicht komplett tot.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request.clone())
        .then((response) => {
          if (!response.ok) return response;

          // Erfolgreiche Antwort cachen
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
          // Offline → Cache versuchen
          const cached = await caches.match(request);
          if (cached) {
            const cachedAt = parseInt(
              cached.headers.get("sw-cached-at") || "0",
            );
            const ageSeconds = (Date.now() - cachedAt) / 1000;

            // Zu alter Cache → trotzdem liefern aber mit Warn-Header
            if (ageSeconds > API_CACHE_MAX_AGE) {
              console.warn(`[Chat SW] Cache veraltet für ${url.pathname}`);
            }
            return cached;
          }

          // Gar kein Cache
          return new Response(
            JSON.stringify({ error: "Offline – keine gecachten Daten" }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          );
        }),
    );
    return;
  }

  // ── 2. EIGENE CHAT-DATEIEN: Cache First ───────────────────────────────────
  // /chat/* Pfade → sofort aus Cache, Background-Revalidate
  if (url.pathname.startsWith("/chat/") || url.pathname === "/chat") {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          // Stale-While-Revalidate: Cache sofort liefern, im Hintergrund updaten
          fetch(request)
            .then((response) => {
              if (response.ok) {
                caches
                  .open(CACHE_STATIC)
                  .then((cache) => cache.put(request, response.clone()));
              }
            })
            .catch(() => {});
          return cached;
        }

        // Nicht im Cache → vom Netz holen
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              caches
                .open(CACHE_STATIC)
                .then((cache) => cache.put(request, response.clone()));
            }
            return response;
          })
          .catch(() => {
            // Fallback zur index.html (SPA-Verhalten)
            return caches.match("/chat/index.html");
          });
      }),
    );
    return;
  }

  // ── 3. EXTERNE RESSOURCEN (Fonts, CDN): Runtime Cache ─────────────────────
  if (
    url.origin !== self.location.origin &&
    (url.hostname.includes("fonts.googleapis.com") ||
      url.hostname.includes("fonts.gstatic.com") ||
      url.hostname.includes("unpkg.com"))
  ) {
    event.respondWith(
      caches.open(CACHE_RUNTIME).then(async (cache) => {
        const cached = await cache.match(request);

        if (cached) {
          // SWR: Cached sofort, Update im Hintergrund
          fetch(request)
            .then((response) => {
              if (response.ok) {
                cache.put(request, response.clone());
                limitRuntimeCache();
              }
            })
            .catch(() => {});
          return cached;
        }

        // Nicht im Cache → holen und cachen
        const response = await fetch(request).catch(() => null);
        if (response && response.ok) {
          cache.put(request, response.clone());
          limitRuntimeCache();
        }
        return response || new Response("", { status: 504 });
      }),
    );
    return;
  }

  // Alle anderen Requests: normal durchlassen (nicht cachen)
});

// ══════════════════════════════════════════════════════════════════════════════
// HELPER: Runtime-Cache Größe begrenzen
// ══════════════════════════════════════════════════════════════════════════════
async function limitRuntimeCache() {
  const cache = await caches.open(CACHE_RUNTIME);
  const keys = await cache.keys();
  if (keys.length > MAX_RUNTIME_ENTRIES) {
    const toDelete = keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES);
    await Promise.all(toDelete.map((req) => cache.delete(req)));
    console.log(
      `[Chat SW] Runtime-Cache auf ${MAX_RUNTIME_ENTRIES} Einträge begrenzt`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { title: "SpotMe Chat", body: event.data?.text() || "" };
  }

  const options = {
    body: data.body || "",
    icon: "/chat/icons/pwa_192.png",
    badge: "/chat/icons/pwa_72.png",
    data: { url: data.url || "/chat/" },
    vibrate: [200, 100, 200],
    tag: data.tag || "spotme-chat",
    renotify: true,
    silent: false,
    actions: [
      {
        action: "reply",
        title: "💬 Antworten",
        type: "text",
        placeholder: "Nachricht eingeben…",
      },
      {
        action: "dismiss",
        title: "Ignorieren",
      },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "SpotMe Chat", options),
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION CLICK – App öffnen / fokussieren
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Reply-Action: Inline-Antwort
  if (event.action === "reply" && event.reply) {
    // Antwort an Client senden, der sie dann verschickt
    event.waitUntil(
      clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clientList) => {
          const client = clientList[0];
          if (client) {
            client.postMessage({
              type: "PUSH_REPLY",
              text: event.reply,
            });
            client.focus();
          }
        }),
    );
    return;
  }

  const targetUrl = event.notification.data?.url || "/chat/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Existierenden Tab fokussieren
        for (const client of clientList) {
          if (
            client.url.includes(self.location.origin + "/chat/") &&
            "focus" in client
          ) {
            client.focus();
            client.postMessage({
              type: "PUSH_NAVIGATE",
              url: targetUrl,
            });
            return;
          }
        }

        // Kein Tab offen → neuen öffnen
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      }),
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE vom Client (z.B. "neue Nachricht gesendet" → Badges updaten)
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data?.type === "CLEAR_API_CACHE") {
    caches.delete(CACHE_API).then(() => {
      console.log("[Chat SW] API-Cache geleert");
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PERIODIC SYNC (für Hintergrund-Aktualisierung – experimentell)
// Erfordert `periodic` Permission und registered Periodic Sync
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "chat-refresh") {
    event.waitUntil(
      clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clientList) => {
          clientList.forEach((client) => {
            client.postMessage({ type: "PERIODIC_SYNC" });
          });
        }),
    );
  }
});
