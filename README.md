# 🗺️ SpotMe · Caching

> **Entdecke. Verbinde. Triff dich.**  
> Eine mobile-first PWA zum Setzen, Teilen und Entdecken von geheimen Spots — mit integriertem Einladungssystem, Profilen, Chat, Wochen-Spots und In-App-Navigation.

![1781260252518~3](_res/1781260252518~3.png)

---

## 📖 Über das Projekt

SpotMe Caching ist ein Open-Source-Geocaching-Konzept das über klassisches Geocaching hinausgeht. Es verbindet standortbasiertes Entdecken mit einem sozialen Layer — Nutzer setzen Spots, hinterlassen Fotos und Beschreibungen, laden andere ein und kommunizieren direkt über den integrierten Messenger.

Das Projekt läuft als Progressive Web App (PWA) direkt im Browser — keine App-Installation nötig.

---

## ✨ Features

### 🗺️ Karte
- **MapLibre GL** mit OpenFreeMap Tiles — 100% Open Source, kein API-Key
- Eigene Spot-Marker (Amber) mit Online-Puls-Indikator
- Fremde Spot-Marker mit Live-Online-Status
- **Kategorie-Filter-Strip** — horizontale Pills auf der Karte (Park, Restaurant, Strand …) filtern Spots live nach Kategorie
- **Radius-Suche** (2 / 5 / 10 km) mit GeoJSON-Kreis und kombiniertem Kategorie-Filter direkt im Such-Modal — Ergebnisse sortiert nach Entfernung, mit Wetter-Badge und Navigations-Button
- **Neue Spots** — zeigt Spots der letzten 24h im 2 km Umkreis mit grünem Puls-Marker

### 🧭 In-App Navigation
- **Vollbild-Overlay** ersetzt Google Maps komplett — kein App-Wechsel
- Live-GPS-Tracking via `watchPosition` — User-Marker bewegt sich in Echtzeit
- **Zwei Routen gleichzeitig:**
  - 🚶 Fußweg (Cyan, gestrichelt) via **OpenRouteService `foot-hiking`** — kennt Wanderwege, Trampelpfade und unbefestigte Off-Road-Tracks
  - 🚗 Auto (Amber) via **OSRM** — klassisches Straßenrouting
- **25 m Schwelle** — Route wird nur neu berechnet wenn der Nutzer wirklich weitergelaufen ist (kein API-Spam, keine Unruhe)
- Karte folgt dem Nutzer automatisch — ⊕-Button holt die Zentrierung zurück nach manuellem Scrollen
- Distanz, Fußzeit und Fahrzeit permanent im unteren Panel sichtbar
- Schließen per ✕, „Navigation beenden"-Button oder ESC

### 🗓️ Wochen-Spots
- **Privater Spot mit 7-Tage-Ablauf** — erstellen, Link teilen, fertig
- Kein Login für Besucher nötig — jeder mit dem Link kann den Spot sehen und einchecken
- Anonyme Check-ins mit Label (Anonym #1, #2 …)
- Countdown bis zum Ablauf live auf der Ansichtsseite (`spot-woche.html`)
- Eigene Wochen-Spots verwalten (Erstellen, Teilen, Löschen) über neues 🗓️-Icon in der Topbar
- Automatische Datenbankbereinigung nach Ablauf
- Native Share-API für iOS/Android — ein Tap zum Teilen

### 📍 Spots
- Spot setzen über dedizierte Erstellungsseite (`spot-erstellen.html`) mit Kategorie, Tageszeit, Andrang und Intimität
- Kategorien mit Emoji (Park 🌳, Restaurant 🍽️, Strand 🏖️ …)
- Name, Beschreibung, Wunsch-Tag und optionales Foto pro Spot
- Foto-Upload mit automatischer Canvas-Komprimierung (JPEG 72%)
- Spot bearbeiten und löschen
- **Spot deaktivieren / reaktivieren** — Soft Delete
- Spot-Alter-Anzeige (gerade eben / vor X Min / vor Xh / gestern)
- Foto-Fullscreen per Tap
- Bild-Moderation: neues Spot-Foto muss vom Admin freigegeben werden
- **Open-Meteo Wetter** — Vorhersage für die nächsten 8 Stunden direkt im Spot-Detail

### 👤 Profile
- Anzeigename, Geburtsjahr (einmalig), Region/Provinz/Stadt
- Bio, Wünsche und Angebote als Chip-Tags
- Avatar-Upload mit automatischer Komprimierung (Canvas, JPEG 72%)
- Avatar-Moderation durch Admin
- Meine Spots Tab — alle eigenen Spots in der Profilansicht
- **Account-Backup & Restore** — vollständiger Export als JSON-Datei inkl. Code + Token; nach Cache-Löschen oder Gerätewechsel vollständig wiederherstellbar durch Serverabgleich

### 📨 Einladungssystem
- Einladung an Spot-Inhaber senden (Zeitraum wählen)
- Akzeptieren / Ablehnen
- Check-in per GPS wenn beide am Spot sind (50 m-Radius-Prüfung)
- Match-Screen bei gegenseitigem Check-in + automatische gegenseitige Verifikation
- **Abgelaufene Einladungen** werden automatisch archiviert (`expired`) — nach 30 Tagen automatisch gelöscht

### 💬 Chat & Messenger
- Direktnachrichten zwischen Nutzer und Spot-Inhaber — ohne vorherige Einladung
- **Chat-Liste** (WhatsApp-Style) mit Vorschautext, Uhrzeit und Ungelesen-Zähler
- **Hintergrund-Benachrichtigung** — Chat-Icon pulsiert mit Badge-Zähler für neue Nachrichten
- Offline-Nachrichten — werden zugestellt wenn der Empfänger wieder online ist
- Nachrichten werden clientseitig im localStorage gespeichert für sofortige Anzeige

### 🔐 Datenschutz
- Eigener Standort wird **nicht** für andere sichtbar auf der Karte
- Nur Online-Status (● / ○) wird angezeigt — kein Rückschluss auf Standort möglich
- Spot-Fotos erst nach Admin-Freigabe sichtbar
- Alle Profildaten werden serverseitig mit **AES-256-CBC** verschlüsselt gespeichert

### 📱 PWA
- Installierbar auf iOS und Android
- Offline-fähig via Service Worker
- Cache-Strategie: Static Files → Stale-While-Revalidate, API → immer Network
- `CACHE_VERSION` in `sw.js` bei jedem Deploy hochzählen

---

## 🏗️ Technologie-Stack

| Bereich | Technologie |
|---|---|
| Frontend | Vanilla JS, HTML5, CSS3 — keine Frameworks, keine Dependencies |
| Karte | [MapLibre GL](https://maplibre.org/) |
| Tiles | [OpenFreeMap](https://openfreemap.org/) (Liberty / Bright Style) |
| Routing Fußweg | [OpenRouteService](https://openrouteservice.org/) `foot-hiking` (kostenloser API-Key) |
| Routing Auto | [OSRM](https://project-osrm.org/) (kein Key nötig) |
| Wetter | [Open-Meteo](https://open-meteo.com/) (kostenlos, kein Key) |
| Backend | Node.js + Express |
| Datenbank | PostgreSQL via [Neon](https://neon.tech/) (Serverless) |
| Hosting | GitHub Pages (Frontend) + [Render](https://render.com/) (Backend) |
| Verschlüsselung | AES-256-CBC via Node.js `crypto` |
| Fonts | Google Fonts — Space Mono, Outfit |

---

## 📁 Dateistruktur

```
spotme-caching/
├── index.html              # Hauptkarte — Spots, Navigation, Chat, Wochen-Spots
├── spot-erstellen.html     # Spot-Erstellungsseite (Kategorie, Foto, GPS)
├── spot-woche.html         # Öffentliche Ansicht für geteilte Wochen-Spots
├── profil-caching.html     # Profil erstellen / bearbeiten / Backup
├── admin.html              # Admin-Panel (Avatar + Spot-Bild Moderation)
├── 404.html                # Custom 404-Seite (PWA-Style)
├── manifest.json           # PWA Manifest
├── sw.js                   # Service Worker (Cache-Strategie)
└── server.js               # Backend (Node.js + Express + PostgreSQL)
```

---

## 🚀 Setup

### Voraussetzungen
Node.js ≥ 18 und eine PostgreSQL-Datenbank (z.B. via [Neon](https://neon.tech/)) werden benötigt.

### Backend starten

```bash
npm install
DATABASE_URL=postgres://... ADMIN_KEY=dein-geheimes-key CRYPTO_KEY=$(openssl rand -hex 32) node server.js
```

### Environment Variables (Render)

| Variable | Beschreibung |
|---|---|
| `DATABASE_URL` | PostgreSQL Connection String (von Neon oder Render) |
| `ADMIN_KEY` | Geheimer Key für Admin-Panel |
| `CRYPTO_KEY` | 64-stelliger Hex-String für AES-256-Datenverschlüsselung (`openssl rand -hex 32`) |
| `PORT` | Server-Port (Standard: 3000, wird von Render automatisch gesetzt) |

### OpenRouteService API-Key

Für `foot-hiking` Navigation kostenlos registrieren unter [openrouteservice.org](https://openrouteservice.org).  
Key in `index.html` eintragen:

```js
const ORS_KEY = 'dein-ors-key-hier'; // Zeile ~902
```

Ohne Key: automatischer Fallback auf OSRM `foot` (nur befestigte Wege).

### Frontend deployen

Alle HTML-Dateien auf GitHub Pages deployen. Der Service Worker wird automatisch registriert.

**Wichtig bei jedem Update:** `CACHE_VERSION` in `sw.js` hochzählen.

```js
const CACHE_VERSION = 'v9'; // bei jedem Deploy um 1 erhöhen
```

### Datenbank einrichten

Alle Tabellen werden beim ersten Serverstart automatisch durch `initDB()` erstellt — inklusive `weekly_spots`. Keine manuellen Migrationen nötig.

---

## 🗄️ Datenbank-Tabellen

| Tabelle | Inhalt |
|---|---|
| `profiles` | Nutzerprofile (verschlüsselt via AES-256) |
| `user_spots` | Spots mit Koordinaten, Foto, Beschreibung, Kategorie, `active`-Status |
| `spot_cache_invites` | Treffpunkt-Einladungen mit Zeitfenstern und Status-Lifecycle |
| `offline_messages` | Nachrichten an offline Nutzer + Chat-Nachrichten (`spot_type`) |
| `verifications` | Persönliche Verifikationen nach erfolgreichem Check-in |
| `profile_comments` | Story-Kommentare |
| `weekly_spots` | Wochen-Spots (privat, 7-Tage-Ablauf, anonyme Check-ins via Link) |

---

## 🗺️ API-Endpunkte

```
GET    /api/userspots/all               Alle aktiven Spots (WHERE active = true)
GET    /api/userspots/:code             Spots eines Nutzers
POST   /api/userspots                   Neuen Spot anlegen
PUT    /api/userspots/:id               Spot bearbeiten
PATCH  /api/userspots/:id/toggle        Spot aktivieren / deaktivieren (Soft Delete)
DELETE /api/userspots/:id               Spot endgültig löschen

POST   /api/profile                     Profil erstellen / aktualisieren
GET    /api/profile/:code               Profil abrufen (entschlüsselt)
POST   /api/avatar                      Avatar hochladen (→ pending)
GET    /api/avatar/:code                Avatar abrufen (nur approved)

POST   /api/spotcache/invite            Einladung senden (mit Zeitfenster)
GET    /api/spotcache/invites/:code     Einladungen abrufen (inkl. expired)
POST   /api/spotcache/invite/respond    Einladung akzeptieren / ablehnen
POST   /api/spotcache/checkin           Check-in am Spot (50m-Radius-Prüfung)

POST   /api/message                     Chat-Nachricht senden
GET    /api/messages/:code              Chat-Nachrichten abrufen

POST   /api/weekly-spots                Wochen-Spot erstellen (Auth required)
GET    /api/weekly-spots/mine           Meine Wochen-Spots (Auth required)
GET    /api/weekly-spots/:token         Spot öffentlich abrufen (kein Login)
POST   /api/weekly-spots/:token/checkin Anonym einchecken (kein Login)
DELETE /api/weekly-spots/:token         Wochen-Spot löschen (Auth required)

GET    /api/admin/pending-avatars       Avatar-Moderation
POST   /api/admin/avatar-action         Avatar freigeben / ablehnen
GET    /api/admin/pending-spot-images   Spot-Bild-Moderation
POST   /api/admin/spot-image-action     Spot-Bild freigeben / ablehnen
```

---

## 🔒 Admin-Panel

Das Admin-Panel (`admin.html`) ermöglicht die Moderation von Avatar-Fotos und Spot-Fotos (Freigeben oder Ablehnen). Der Zugang erfolgt mit dem `ADMIN_KEY` aus den Environment Variables. Neue Fotos sind standardmäßig `pending` und erst nach manueller Freigabe sichtbar.

---

## 🔮 Roadmap

### ✅ Bereits implementiert
- [x] Spot setzen, bearbeiten, löschen
- [x] Spot-Kategorie-System mit Emoji (Park, Restaurant, Strand …)
- [x] Kategorie-Filter-Strip auf der Karte
- [x] Kombinierte Radius + Kategorie-Suche mit Wetter-Badge und Distanz-Sortierung
- [x] Einladungssystem mit Zeitfenstern
- [x] GPS Check-in mit 50m-Radius-Prüfung
- [x] Gegenseitige Verifikation nach Check-in
- [x] Chat direkt aus Spot-Detail (ohne vorherige Einladung)
- [x] Chat-Liste mit Ungelesen-Badge
- [x] Hintergrund-Benachrichtigung für neue Nachrichten
- [x] Abgelaufene Einladungen archivieren (Soft Expire nach 30 Tagen)
- [x] Spot deaktivieren / reaktivieren (Soft Delete)
- [x] Account-Backup & Restore per JSON-Datei
- [x] AES-256-Verschlüsselung aller Profildaten
- [x] Avatar- und Spot-Foto-Moderation durch Admin
- [x] Service Worker mit intelligenter Cache-Strategie
- [x] Open-Meteo Wetter im Spot-Detail und Einladungen
- [x] Wochen-Spot — privater 7-Tage-Spot mit anonymem Link-Sharing
- [x] In-App Navigation — Vollbild-Overlay mit Live-GPS, foot-hiking (ORS) + Auto (OSRM)

### 🔜 Demnächst geplant
- [ ] **Ankunftserkennung** — „Du bist angekommen"-Meldung wenn Nutzer <20 m vom Spot entfernt ist
- [ ] **Server-Sent Events (SSE)** — Ersetzt das aktuelle 10s-Polling für Chat/Benachrichtigungen. Sinnvoll ab ~500 aktiven gleichzeitigen Nutzern. Stack: Express SSE + PostgreSQL `LISTEN/NOTIFY`. Bis dahin bleibt Polling aktiv.
- [ ] **Spot-Besuchshistorie** — nach erfolgreichem Check-in wird der Spot in einer persönlichen „Bereits besucht"-Liste im Profil gespeichert
- [ ] **Marker-Clustering** — bei vielen Spots in einem Bereich werden diese zu einer Gruppe zusammengefasst
- [ ] **Haptic Feedback** — kurze Vibration bei wichtigen Aktionen (Check-in, neue Nachricht)
- [ ] **Spot-Ablaufdatum** — Eigentümer kann einen Zeitraum setzen nach dem der Spot automatisch deaktiviert wird

---

## 📜 Lizenz

MIT — Open Source. Nutzung, Modifikation und Weitergabe erlaubt.

---

## 👤 Autor

**Dragons Chain** · Costa Brava, Spanien  
Entwickelt im SpotMe Ökosystem — radikal transparent, zero-profit.

> *"Nicht jeder Spot ist auf der Karte. Manche muss man sich verdienen."*
