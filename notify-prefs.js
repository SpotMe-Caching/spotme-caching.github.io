/* SpotMe – Benachrichtigungs-Einstellungen (pro Nutzer)
 *
 * Pro Funktion drei Stufen:
 *   push    → Push aufs Gerät (App/TWA/Browser-Push)
 *   browser → kein Push; Hinweis nur in der App, solange sie offen ist (Postfach, wird beim Öffnen abgeholt)
 *   off     → gar nichts
 * Silent-Modus: alles aus, nichts wird zugestellt oder gespeichert.
 */
"use strict";

const CATEGORIES = [
  { key: "chat",        icon: "💬", label: "Chat-Nachrichten",       desc: "Jemand schreibt dir" },
  { key: "invite",      icon: "📨", label: "Einladungen & Antworten", desc: "Neue Einladung zu einem Treffen, angenommen oder abgelehnt" },
  { key: "weekly",      icon: "🗓️", label: "Wochen-Spot Check-ins",   desc: "Jemand besucht deinen Wochen-Spot" },
  { key: "live_go",     icon: "📡", label: "Live Spot geht live",     desc: "Spots, denen du folgst oder bei denen du angemeldet bist" },
  { key: "live_change", icon: "🛑", label: "Absagen & Löschungen",    desc: "Veranstalter sagt einen Termin ab oder löscht den Live Spot" },
];
const KEYS = new Set(CATEGORIES.map((c) => c.key));
const LEVELS = ["push", "browser", "off"];
const NO_QUEUE = new Set(["chat"]); // Chat holt die App ohnehin selbst ab (Badge/Verlauf)
const INBOX_MAX = 100;

module.exports = function makeNotify(pool) {
  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_prefs (
        code       TEXT PRIMARY KEY,
        silent     BOOLEAN NOT NULL DEFAULT false,
        prefs      JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notification_inbox (
        id         SERIAL PRIMARY KEY,
        code       TEXT NOT NULL,
        category   TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        url        TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ninbox_code ON notification_inbox(code);
    `);
  }
  let schemaP = null;
  const ready = () => (schemaP = schemaP || ensureSchema().catch((e) => { schemaP = null; throw e; }));

  function normalize(row) {
    const prefs = {};
    const stored = (row && row.prefs) || {};
    for (const c of CATEGORIES) prefs[c.key] = LEVELS.includes(stored[c.key]) ? stored[c.key] : "push";
    return { silent: !!(row && row.silent), prefs };
  }

  async function getPrefs(code) {
    await ready();
    const { rows } = await pool.query("SELECT silent, prefs FROM notification_prefs WHERE code = $1", [code]);
    return normalize(rows[0]);
  }

  // Map code → Stufe für eine Kategorie
  async function levelsFor(codes, category) {
    await ready();
    const uniq = [...new Set(codes.map(String))];
    const out = new Map(uniq.map((c) => [c, "push"]));
    if (!uniq.length) return out;
    const { rows } = await pool.query(
      "SELECT code, silent, prefs FROM notification_prefs WHERE code = ANY($1::text[])",
      [uniq],
    );
    for (const r of rows) {
      const n = normalize(r);
      out.set(r.code, n.silent ? "off" : n.prefs[category] || "push");
    }
    return out;
  }

  async function queue(code, category, p) {
    await ready();
    await pool.query(
      "INSERT INTO notification_inbox (code, category, title, body, url) VALUES ($1,$2,$3,$4,$5)",
      [code, category, String(p.title || "").slice(0, 160), String(p.body || "").slice(0, 300), String(p.url || "/").slice(0, 300)],
    );
    // alt + Überlauf aufräumen
    await pool.query(
      `DELETE FROM notification_inbox WHERE code = $1 AND (created_at < NOW() - INTERVAL '48 hours'
         OR id NOT IN (SELECT id FROM notification_inbox WHERE code = $1 ORDER BY id DESC LIMIT ${INBOX_MAX}))`,
      [code],
    );
  }

  // Entscheidet pro Empfänger. payload: Objekt oder (code) => Objekt.
  // Rückgabe: Set der Codes, die einen Push bekommen sollen. 'browser' wird ins Postfach gelegt.
  async function route(codes, category, payload) {
    const levels = await levelsFor(codes, category);
    const pushSet = new Set();
    for (const [code, lvl] of levels) {
      if (lvl === "push") pushSet.add(code);
      else if (lvl === "browser" && !NO_QUEUE.has(category)) {
        try { await queue(code, category, typeof payload === "function" ? payload(code) : payload); } catch (e) { console.error("notify queue:", e.message); }
      }
    }
    return pushSet;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  function mount(app, { authCheck, sendPush, decrypt }) {
    const auth = async (req, res, src) => {
      const code = String(src.code || "");
      const token = String(src.token || req.headers["x-spotme-token"] || "");
      if (!code || !token) { res.status(401).json({ error: "code + token erforderlich" }); return null; }
      if (!(await authCheck(code, token))) { res.status(403).json({ error: "Ungültiger Token" }); return null; }
      return code;
    };
    const wrap = (fn) => async (req, res) => {
      try { await fn(req, res); } catch (e) {
        console.error(`notify ${req.method} ${req.path}:`, e.message);
        if (!res.headersSent) res.status(500).json({ error: "Datenbankfehler" });
      }
    };

    app.get("/api/notifications/prefs", wrap(async (req, res) => {
      const code = await auth(req, res, req.query); if (!code) return;
      res.json({ ...(await getPrefs(code)), categories: CATEGORIES, levels: LEVELS });
    }));

    app.put("/api/notifications/prefs", wrap(async (req, res) => {
      const code = await auth(req, res, req.body || {}); if (!code) return;
      const b = req.body || {};
      const cur = await getPrefs(code);
      let silent = cur.silent;
      if (b.silent !== undefined) {
        if (typeof b.silent !== "boolean") return res.status(400).json({ error: "silent muss true/false sein" });
        silent = b.silent;
      }
      const prefs = { ...cur.prefs };
      if (b.prefs !== undefined) {
        if (!b.prefs || typeof b.prefs !== "object" || Array.isArray(b.prefs))
          return res.status(400).json({ error: "prefs ungültig" });
        for (const [k, v] of Object.entries(b.prefs)) {
          if (!KEYS.has(k) || !LEVELS.includes(v)) return res.status(400).json({ error: `Ungültig: ${k}` });
          prefs[k] = v;
        }
      }
      await ready();
      await pool.query(
        `INSERT INTO notification_prefs (code, silent, prefs, updated_at) VALUES ($1,$2,$3::jsonb,NOW())
         ON CONFLICT (code) DO UPDATE SET silent = EXCLUDED.silent, prefs = EXCLUDED.prefs, updated_at = NOW()`,
        [code, silent, JSON.stringify(prefs)],
      );
      // Silent: wartende Hinweise sofort verwerfen
      if (silent) await pool.query("DELETE FROM notification_inbox WHERE code = $1", [code]);
      res.json({ success: true, silent, prefs });
    }));

    // Postfach für „nur im Browser“-Hinweise; liefert auch die aktuellen Einstellungen (Client-Cache)
    app.get("/api/notifications/inbox", wrap(async (req, res) => {
      const code = await auth(req, res, req.query); if (!code) return;
      const pr = await getPrefs(code);
      let items = [];
      if (!pr.silent) {
        const { rows } = await pool.query(
          `SELECT id, category, title, body, url, created_at FROM notification_inbox
           WHERE code = $1 AND created_at > NOW() - INTERVAL '48 hours' ORDER BY id ASC LIMIT 50`,
          [code],
        );
        items = rows;
      }
      res.json({ items, silent: pr.silent, prefs: pr.prefs });
    }));

    app.post("/api/notifications/inbox/ack", wrap(async (req, res) => {
      const code = await auth(req, res, req.body || {}); if (!code) return;
      const ids = Array.isArray(req.body.ids)
        ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : [];
      if (ids.length) await pool.query("DELETE FROM notification_inbox WHERE code = $1 AND id = ANY($2::int[])", [code, ids]);
      res.json({ success: true, acked: ids.length });
    }));

    // Alles auf einmal für die App (statt 3 Einzelabrufe alle 10 s): Chat + Favoriten-Hinweise + Postfach + Einstellungen.
    // Eine Auth-Prüfung, die 4 Abfragen laufen parallel.
    app.get("/api/poll", wrap(async (req, res) => {
      const code = await auth(req, res, req.query); if (!code) return;
      await ready();
      const [pr, msgs, fav, inb] = await Promise.all([
        getPrefs(code),
        pool.query(
          `SELECT id, sender_code, sender_name, message, spot_type, created_at FROM offline_messages
           WHERE recipient = $1 AND spot_type = 'caching_chat' AND read = FALSE
             AND created_at > NOW() - INTERVAL '48 hours' ORDER BY id ASC LIMIT 200`, [code]),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM offline_messages
           WHERE recipient = $1 AND spot_type = 'favorite_checkin' AND read = FALSE
             AND created_at > NOW() - INTERVAL '48 hours'`, [code]),
        pool.query(
          `SELECT id, category, title, body, url, created_at FROM notification_inbox
           WHERE code = $1 AND created_at > NOW() - INTERVAL '48 hours' ORDER BY id ASC LIMIT 50`, [code]),
      ]);
      const dec = typeof decrypt === "function" ? decrypt : (x) => x;
      res.json({
        messages: msgs.rows.map((r) => ({ ...r, sender_name: dec(r.sender_name), message: dec(r.message) })),
        favorites: fav.rows[0].n,
        inbox: pr.silent ? [] : inb.rows,
        silent: pr.silent,
        prefs: pr.prefs,
      });
    }));

    // Test-Push an die Geräte dieses Nutzers (respektiert Silent)
    app.post("/api/notifications/test", wrap(async (req, res) => {
      const code = await auth(req, res, req.body || {}); if (!code) return;
      const pr = await getPrefs(code);
      if (pr.silent) return res.json({ success: false, skipped: "silent" });
      const ok = await sendPush(code, "🔔 SpotMe Test", "Benachrichtigungen funktionieren auf diesem Gerät.", "/");
      res.json({ success: !!ok, delivered: !!ok });
    }));
  }

  return { CATEGORIES, LEVELS, ensureSchema, getPrefs, levelsFor, route, queue, mount };
};
