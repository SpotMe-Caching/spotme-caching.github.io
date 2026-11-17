# DEVLOG · Abstimmung zwischen Chats

Diese Datei liegt im Repo-Root und ist die einzige verlässliche Übergabe zwischen mehreren Claude-Chats (und zwischen Chat und Mensch).

**Regeln**
1. **Zu Beginn eines Chats:** Diese Datei lesen (Abschnitt „Gerade in Arbeit“ zuerst).
2. **Vor dem Ändern:** Dateien unter „Gerade in Arbeit“ eintragen. Eine Datei darf nur in einem Chat gleichzeitig bearbeitet werden.
3. **Nach dem Ändern:** Eintrag oben in „Verlauf“ schreiben, danach die Zeile unter „Gerade in Arbeit“ löschen.
4. **Nur eine Quelle:** Immer von der aktuellen Repo-Version ausgehen, nie von einer alten Kopie.

---

## Gerade in Arbeit

| Chat | Dateien | Seit | Notiz |
|------|---------|------|-------|
| – | – | – | – |

---

## Verlauf (neueste zuerst)

### 2026-11-17 · Chat „Messenger-Ideen und Retro-Theme“

**Stand gesichtet** (ZIP von `main`)
- `sw.js` im Root: `CACHE_VERSION = "v399.19"`.
- Schriften sind lokal: Ordner `/fonts` und `fonts.css` sind vorhanden und in vielen Seiten eingebunden.
- Messenger: eigene Mini-PWA in `/chat/` (`index.html`, `sw.js`, `webrtc.js`, `messenger.css`, `peerjs.min.js` lokal). Zusätzlich liegen `messenger.html`, `chat.html` und `chat-core.js` im Root.
- Weitere Ordner: `locales/` (de, en, es), `help/`, `doku/`, `android-app/` mit `.github/workflows/build-apk.yml`.

**Neu erstellt, noch NICHT im Repo**
- `info.html`: Marketing-Seite (Funktionen mit Szenarien, Zielgruppen junge Leute, Fotografen, Models).
- `retro.css`: Retro-Theme im Windows-98-Stil für den Messenger, aktiviert über `<body class="retro">`, nach `messenger.css` laden.
- `grid.js`: Node-Skript, das ein 50-km-Raster (EPSG:3035) als GeoJSON über eine Grenzdatei legt.
- `sound.html`: nur Demo zum Anhören von drei selbst erzeugten Benachrichtigungstönen, nicht fürs Repo gedacht.

**Keine bestehenden Dateien geändert.**

**Offen**
- Es gibt noch Google-Fonts-Verweise in `doku-index.html`, `doku/doku-index.html`, `spot-caching.html`, `alle-spots.html` und `chat/sw.js` (wegen DSGVO auf lokale Schriften umstellen).
- Messenger auf eigener Adresse (`spotme-messenger.github.io`) ist nur geplant, noch nichts umgesetzt. Dafür müssten alle `/chat/…`-Pfade in Manifest und Service Worker angepasst werden.
- Entschieden: keine Post-Quanten-Verschlüsselung für den Chat.
- Idee, nicht gebaut: Sprachnachrichten nur über P2P, analog zu `sendImage()` in `webrtc.js`.
