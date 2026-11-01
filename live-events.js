"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// live-events.js – Live Spots als Event mit Anmeldung ("Ticket")
//
//  • Anmeldung vorab (Reservieren), optionales Teilnehmer-Limit (leer = unbegrenzt)
//  • Check-in per GPS (Radius CHECKIN_RADIUS_M) → "Eingecheckt"
//  • Ist das Limit erreicht, ist der Live Spot für alle Nicht-Teilnehmer
//    SERVERSEITIG unsichtbar (404) – Liste, Einzelabruf per ID und Token,
//    Following-Liste, Folgen und Push. Veranstalter und Angemeldete sehen ihn immer.
//  • Veranstalter: Teilnehmer- und Follower-Liste (nur Namen, keine Codes)
//
// Einbau in server.js: siehe README. Diese Datei überschreibt (weil früher
// registriert) die Routen GET /api/live-spots, /following, /:id, POST /api/live-spots,
// PUT /:id und POST /:id/follow aus server.js. /mine, /golive, /gooffline und
// DELETE /follow bleiben unverändert in server.js.
// ═══════════════════════════════════════════════════════════════════════════

const CHECKIN_RADIUS_M = 100; // GPS-Radius für "Eingecheckt"
const MAX_LIMIT = 100000; // größtes erlaubtes Teilnehmer-Limit
const CHECKIN_EARLY_MIN = 30; // Check-in bei geplanten Terminen ab x Min vor Start
const PLANNED_GRACE_H = 6; // geplanter Termin bleibt so lange nach Start in der Liste
const MAX_IMAGES = 12; // Event-Bilder pro Live Spot
const MAX_IMAGE_BYTES = 700 * 1024; // pro Bild (nach dem Verkleinern in der App ca. 150 KB)
const FOLLOWER_PUSH_KM = 10; // wie bisher: Follower-Push nur im Umkreis

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = function mountLiveEvents(app, deps) {
  const { pool, authCheck, decrypt, webpush } = deps;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Schema ────────────────────────────────────────────────────────────────
  async function ensureSchema() {
    // live_spots wird beim Start von server.js angelegt – kurz darauf warten
    for (let i = 0; ; i++) {
      try {
        await pool.query("SELECT 1 FROM live_spots LIMIT 1");
        break;
      } catch (e) {
        if (i >= 30) throw e;
        await sleep(2000);
      }
    }
    await pool.query(
      `ALTER TABLE live_spots ADD COLUMN IF NOT EXISTS max_participants INTEGER
         CHECK (max_participants IS NULL OR max_participants >= 1)`,
    );
    await pool.query("ALTER TABLE live_spots ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_participants (
        id               SERIAL PRIMARY KEY,
        live_spot_id     INTEGER NOT NULL REFERENCES live_spots(id) ON DELETE CASCADE,
        participant_code TEXT NOT NULL,
        registered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checked_in_at    TIMESTAMPTZ,
        UNIQUE (live_spot_id, participant_code)
      );
      CREATE INDEX IF NOT EXISTS idx_lp_spot ON live_participants(live_spot_id);
      CREATE INDEX IF NOT EXISTS idx_lp_code ON live_participants(participant_code);
      CREATE TABLE IF NOT EXISTS live_images (
        id           SERIAL PRIMARY KEY,
        live_spot_id INTEGER NOT NULL REFERENCES live_spots(id) ON DELETE CASCADE,
        image        TEXT NOT NULL,
        caption      TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_li_spot ON live_images(live_spot_id);
    `);
  }
  const ready = ensureSchema().catch((e) => {
    console.error("live-events Schema:", e.message);
    throw e;
  });
  ready.catch(() => {}); // kein "unhandled rejection"; Fehler zeigen die Routen

  // ── Helfer ────────────────────────────────────────────────────────────────
  const wrap = (fn) => async (req, res, next) => {
    try {
      await ready;
      await fn(req, res, next);
    } catch (e) {
      console.error(`live-events ${req.method} ${req.path}:`, e.message);
      if (!res.headersSent)
        res.status(500).json({ error: "Datenbankfehler" });
    }
  };

  // Transaktion: fn bekommt einen Client und liefert { status, body }.
  // Alle Prüfungen stehen vor den Schreibzugriffen, daher ist COMMIT auch bei
  // Fehlerantworten harmlos.
  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      c.release();
    }
  }

  function intId(v) {
    const s = String(v);
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n > 0 && n < 2147483647 ? n : null;
  }

  // Ungültige Zugangsdaten gelten als anonym (kein Fehler, kein Hinweis)
  async function viewerOf(code, token) {
    if (!code || !token) return null;
    try {
      return (await authCheck(String(code), String(token))) ? String(code) : null;
    } catch {
      return null;
    }
  }

  function parseCapacity(v) {
    if (v === undefined) return { provided: false };
    if (v === null || v === "") return { provided: true, value: null };
    const s = String(v).trim();
    const n = typeof v === "number" ? v : /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT)
      return {
        error: `Max. Teilnehmer: ganze Zahl von 1 bis ${MAX_LIMIT} (oder leer für unbegrenzt)`,
      };
    return { provided: true, value: n };
  }

  // Termin: undefined = unverändert, null/"" = löschen, sonst ISO-Datum (Zukunft, max. 1 Jahr)
  function parseStart(v) {
    if (v === undefined) return { provided: false };
    if (v === null || v === "") return { provided: true, value: null };
    const d = new Date(v);
    if (typeof v !== "string" || isNaN(d.getTime()))
      return { error: "Ungültiges Datum" };
    const now = Date.now();
    if (d.getTime() < now - 5 * 60000)
      return { error: "Der Termin liegt in der Vergangenheit" };
    if (d.getTime() > now + 366 * 86400000)
      return { error: "Der Termin darf höchstens ein Jahr in der Zukunft liegen" };
    return { provided: true, value: d.toISOString() };
  }

  function parsePlace(b) {
    if (b.lat == null && b.lng == null) return { provided: false };
    const la = Number(b.lat), ln = Number(b.lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180)
      return { error: "Ungültiger Treffpunkt" };
    return {
      provided: true, lat: la, lng: ln,
      note: b.location_note ? String(b.location_note).slice(0, 200) : null,
    };
  }

  const COUNT_SQL =
    "(SELECT COUNT(*)::int FROM live_participants lp WHERE lp.live_spot_id = ls.id)";

  // Sichtbar: kein Limit, oder Veranstalter, oder noch Platz, oder selbst angemeldet.
  // vp = Platzhalter ($n) für den Betrachter (NULL = anonym).
  const visible = (vp) => `(
    ls.max_participants IS NULL
    OR ls.creator_code = ${vp}::text
    OR ${COUNT_SQL} < ls.max_participants
    OR EXISTS (SELECT 1 FROM live_participants lpv
               WHERE lpv.live_spot_id = ls.id AND lpv.participant_code = ${vp}::text)
  )`;

  // Gleiche Felder wie bisher öffentlich + Limit und Anmeldezahl
  const PUBLIC_COLS = `ls.id, ls.token, ls.name, ls.description, ls.category, ls.avatar,
    ls.status, ls.lat, ls.lng, ls.location_note, ls.stream_url, ls.follower_count,
    ls.updated_at, ls.starts_at, ls.max_participants, ${COUNT_SQL} AS participant_count`;

  const notFound = (res) =>
    res.status(404).json({ error: "Live Spot nicht gefunden" });

  async function nameOf(code) {
    const { rows } = await pool.query(
      "SELECT name FROM profiles WHERE code = $1 AND spot = 'caching' LIMIT 1",
      [code],
    );
    return rows.length ? decrypt(rows[0].name) : null;
  }

  // ── Lesen (öffentlich, mit Sichtbarkeitsfilter) ────────────────────────────
  app.get(
    "/api/live-spots",
    wrap(async (req, res) => {
      const viewer = await viewerOf(req.query.code, req.query.token);
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLS} FROM live_spots ls
         WHERE (ls.status = 'online'
                OR (ls.status = 'planned' AND ls.lat IS NOT NULL
                    AND ls.starts_at > NOW() - INTERVAL '${PLANNED_GRACE_H} hours'))
           AND ${visible("$1")}
         ORDER BY (ls.status = 'online') DESC, ls.starts_at ASC NULLS LAST, ls.updated_at DESC`,
        [viewer],
      );
      res.json(rows);
    }),
  );

  // MUSS vor /:id stehen
  app.get(
    "/api/live-spots/following",
    wrap(async (req, res) => {
      const { code, token } = req.query;
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const { rows } = await pool.query(
        `SELECT ls.*, ${COUNT_SQL} AS participant_count FROM live_spots ls
         INNER JOIN live_followers lf ON lf.live_spot_id = ls.id
         WHERE lf.follower_code = $1 AND ${visible("$1")}
         ORDER BY ls.status DESC, ls.updated_at DESC`,
        [String(code)],
      );
      res.json(rows);
    }),
  );

  app.get(
    "/api/live-spots/:id",
    wrap(async (req, res, next) => {
      const raw = req.params.id;
      if (raw === "mine") return next(); // Route aus server.js
      const viewer = await viewerOf(req.query.code, req.query.token);
      const byId = /^\d+$/.test(raw);
      const key = byId ? intId(raw) : raw;
      if (key === null) return notFound(res);
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLS} FROM live_spots ls
         WHERE ${byId ? "ls.id" : "ls.token"} = $1 AND ${visible("$2")}`,
        [key, viewer],
      );
      if (!rows.length) return notFound(res); // verborgen = nicht vorhanden
      res.json(rows[0]);
    }),
  );

  // ── Erstellen / Bearbeiten (mit Limit) ─────────────────────────────────────
  app.post(
    "/api/live-spots",
    wrap(async (req, res) => {
      const { code, token, name, description, category, avatar } = req.body;
      if (!code || !token || !name)
        return res.status(400).json({ error: "code, token, name erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const cap = parseCapacity(req.body.max_participants);
      if (cap.error) return res.status(400).json({ error: cap.error });
      const lsToken = require("crypto").randomBytes(16).toString("hex");
      const { rows } = await pool.query(
        `INSERT INTO live_spots (token, creator_code, name, description, category, avatar, max_participants)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          lsToken,
          code,
          String(name).slice(0, 80),
          description ? String(description).slice(0, 300) : null,
          category || null,
          avatar || null,
          cap.provided ? cap.value : null,
        ],
      );
      console.log(`📡 Live Spot erstellt: "${String(name).slice(0, 80)}" von ${code}`);
      res.json({ success: true, spot: rows[0] });
    }),
  );

  app.put(
    "/api/live-spots/:id",
    wrap(async (req, res) => {
      const { code, token, name, description, category, avatar } = req.body;
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const id = intId(req.params.id);
      if (id === null) return notFound(res);
      const cap = parseCapacity(req.body.max_participants);
      if (cap.error) return res.status(400).json({ error: cap.error });
      const st = parseStart(req.body.starts_at);
      if (st.error) return res.status(400).json({ error: st.error });
      const pl = parsePlace(req.body);
      if (pl.error) return res.status(400).json({ error: pl.error });
      if (st.provided && st.value !== null && !pl.provided) {
        // Termin braucht einen Treffpunkt (neu oder schon vorhanden)
        const h = await pool.query(
          "SELECT lat FROM live_spots WHERE id = $1 AND creator_code = $2", [id, code]);
        if (h.rows.length && h.rows[0].lat == null)
          return res.status(400).json({ error: "Bitte einen Treffpunkt auf der Karte wählen" });
      }

      const out = await tx(async (c) => {
        const s = await c.query(
          "SELECT id FROM live_spots WHERE id = $1 AND creator_code = $2 FOR UPDATE",
          [id, code],
        );
        if (!s.rows.length) return { status: 404, body: { error: "Live Spot nicht gefunden" } };
        if (cap.provided && cap.value !== null) {
          const n = (
            await c.query(
              "SELECT COUNT(*)::int AS n FROM live_participants WHERE live_spot_id = $1",
              [id],
            )
          ).rows[0].n;
          if (cap.value < n)
            return {
              status: 409,
              body: {
                error: `Es sind schon ${n} Personen angemeldet – das Limit kann nicht darunter liegen.`,
              },
            };
        }
        await c.query(
          `UPDATE live_spots SET
             name = COALESCE($1, name), description = $2, category = $3, avatar = $4,
             max_participants = CASE WHEN $5::boolean THEN $6::int ELSE max_participants END,
             starts_at = CASE WHEN $9::boolean THEN $10::timestamptz ELSE starts_at END,
             status = CASE
               WHEN $9::boolean AND $10::timestamptz IS NOT NULL AND status <> 'online' THEN 'planned'
               WHEN $9::boolean AND $10::timestamptz IS NULL AND status = 'planned' THEN 'offline'
               ELSE status END,
             lat = CASE WHEN $11::boolean AND status <> 'online' THEN $12::float8 ELSE lat END,
             lng = CASE WHEN $11::boolean AND status <> 'online' THEN $13::float8 ELSE lng END,
             location_note = CASE WHEN $11::boolean AND status <> 'online' THEN $14::text ELSE location_note END,
             updated_at = NOW()
           WHERE id = $7 AND creator_code = $8`,
          [
            name ? String(name).slice(0, 80) : null,
            description ? String(description).slice(0, 300) : null,
            category || null,
            avatar || null,
            cap.provided,
            cap.provided ? cap.value : null,
            id,
            code,
            st.provided,
            st.provided ? st.value : null,
            pl.provided,
            pl.provided ? pl.lat : null,
            pl.provided ? pl.lng : null,
            pl.provided ? pl.note : null,
          ],
        );
        return { status: 200, body: { success: true } };
      });
      res.status(out.status).json(out.body);
    }),
  );

  // ── Folgen (nur sichtbare Spots) ───────────────────────────────────────────
  app.post(
    "/api/live-spots/:id/follow",
    wrap(async (req, res) => {
      const { code, token } = req.body;
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const id = intId(req.params.id);
      if (id === null) return notFound(res);
      const v = await pool.query(
        `SELECT 1 FROM live_spots ls WHERE ls.id = $1 AND ${visible("$2")}`,
        [id, code],
      );
      if (!v.rows.length) return notFound(res);
      await pool.query(
        `INSERT INTO live_followers (live_spot_id, follower_code) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [id, code],
      );
      await pool.query(
        "UPDATE live_spots SET follower_count = (SELECT COUNT(*) FROM live_followers WHERE live_spot_id=$1) WHERE id=$1",
        [id],
      );
      res.json({ success: true });
    }),
  );

  // ── Anmelden / Abmelden ────────────────────────────────────────────────────
  app.post(
    "/api/live-spots/:id/register",
    wrap(async (req, res) => {
      const { code, token } = req.body;
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const id = intId(req.params.id);
      if (id === null) return notFound(res);

      const out = await tx(async (c) => {
        // Zeile sperren: gleichzeitige Anmeldungen laufen nacheinander,
        // so wird der letzte Platz nie doppelt vergeben
        const s = await c.query(
          "SELECT creator_code, max_participants FROM live_spots WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!s.rows.length) return { status: 404, body: { error: "Live Spot nicht gefunden" } };
        const spot = s.rows[0];
        if (spot.creator_code === code)
          return { status: 400, body: { error: "Du bist der Veranstalter dieses Live Spots." } };
        const already = (
          await c.query(
            "SELECT 1 FROM live_participants WHERE live_spot_id = $1 AND participant_code = $2",
            [id, code],
          )
        ).rows.length;
        const n = (
          await c.query(
            "SELECT COUNT(*)::int AS n FROM live_participants WHERE live_spot_id = $1",
            [id],
          )
        ).rows[0].n;
        if (!already) {
          // voll = für Nicht-Teilnehmer nicht vorhanden (gleiche Antwort wie ein unbekannter Spot)
          if (spot.max_participants !== null && n >= spot.max_participants)
            return { status: 404, body: { error: "Live Spot nicht gefunden" } };
          await c.query(
            "INSERT INTO live_participants (live_spot_id, participant_code) VALUES ($1,$2)",
            [id, code],
          );
        }
        return {
          status: 200,
          body: {
            success: true,
            registered: true,
            participant_count: already ? n : n + 1,
            max_participants: spot.max_participants,
          },
        };
      });
      res.status(out.status).json(out.body);
    }),
  );

  app.delete(
    "/api/live-spots/:id/register",
    wrap(async (req, res) => {
      const { code, token } = req.body || {};
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const id = intId(req.params.id);
      if (id !== null)
        await pool.query(
          "DELETE FROM live_participants WHERE live_spot_id = $1 AND participant_code = $2",
          [id, code],
        );
      res.json({ success: true });
    }),
  );

  // Eigener Status (angemeldet / eingecheckt / Veranstalter)
  app.get(
    "/api/live-spots/:id/me",
    wrap(async (req, res) => {
      const { code, token } = req.query;
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const id = intId(req.params.id);
      const out = { registered: false, checked_in: false, is_owner: false };
      if (id !== null) {
        const o = await pool.query(
          "SELECT 1 FROM live_spots WHERE id = $1 AND creator_code = $2",
          [id, code],
        );
        out.is_owner = o.rows.length > 0;
        const p = await pool.query(
          "SELECT registered_at, checked_in_at FROM live_participants WHERE live_spot_id = $1 AND participant_code = $2",
          [id, code],
        );
        if (p.rows.length) {
          out.registered = true;
          out.registered_at = p.rows[0].registered_at;
          out.checked_in = !!p.rows[0].checked_in_at;
          out.checked_in_at = p.rows[0].checked_in_at;
        }
      }
      res.json(out);
    }),
  );

  // ── Check-in per GPS ───────────────────────────────────────────────────────
  app.post(
    "/api/live-spots/:id/checkin",
    wrap(async (req, res) => {
      const { code, token, lat, lng } = req.body;
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const la = Number(lat);
      const ln = Number(lng);
      if (
        lat == null ||
        lng == null ||
        !Number.isFinite(la) ||
        !Number.isFinite(ln) ||
        Math.abs(la) > 90 ||
        Math.abs(ln) > 180
      )
        return res.status(400).json({ error: "lat + lng erforderlich" });
      const id = intId(req.params.id);
      // gleiche Antwort für "unbekannter Spot" und "nicht angemeldet"
      const noTicket = { error: "Du bist für diesen Live Spot nicht angemeldet." };
      if (id === null) return res.status(403).json(noTicket);
      const r = await pool.query(
        `SELECT ls.status, ls.lat, ls.lng, ls.starts_at
         FROM live_participants lp JOIN live_spots ls ON ls.id = lp.live_spot_id
         WHERE lp.live_spot_id = $1 AND lp.participant_code = $2`,
        [id, code],
      );
      if (!r.rows.length) return res.status(403).json(noTicket);
      const s = r.rows[0];
      const earlyOk =
        s.status === "planned" && s.starts_at &&
        new Date(s.starts_at).getTime() - Date.now() <= CHECKIN_EARLY_MIN * 60000;
      if ((s.status !== "online" && !earlyOk) || s.lat == null || s.lng == null)
        return res.status(400).json({
          error: s.status === "planned"
            ? `Der Check-in startet ${CHECKIN_EARLY_MIN} Minuten vor Beginn.`
            : "Der Live Spot ist gerade nicht live.",
        });
      const dist = haversineM(la, ln, Number(s.lat), Number(s.lng));
      if (dist > CHECKIN_RADIUS_M)
        return res.status(400).json({
          error: `Du bist noch etwa ${Math.round(dist / 10) * 10} m entfernt (Check-in ab ${CHECKIN_RADIUS_M} m).`,
          distance_m: Math.round(dist / 10) * 10,
        });
      const u = await pool.query(
        `UPDATE live_participants SET checked_in_at = COALESCE(checked_in_at, NOW())
         WHERE live_spot_id = $1 AND participant_code = $2 RETURNING checked_in_at`,
        [id, code],
      );
      res.json({ success: true, checked_in: true, checked_in_at: u.rows[0].checked_in_at });
    }),
  );

  // ── Veranstalter: Teilnehmer- und Follower-Liste ───────────────────────────
  async function ownerOnly(req, res) {
    const src = req.method === "GET" ? req.query : req.body || {};
    const { code, token } = src;
    if (!code || !token) {
      res.status(400).json({ error: "code + token erforderlich" });
      return null;
    }
    if (!(await viewerOf(code, token))) {
      res.status(403).json({ error: "Ungültiger Token" });
      return null;
    }
    const id = intId(req.params.id);
    const deny = () => {
      res.status(403).json({ error: "Nur für den Veranstalter" });
      return null;
    };
    if (id === null) return deny();
    const o = await pool.query(
      "SELECT max_participants FROM live_spots WHERE id = $1 AND creator_code = $2",
      [id, code],
    );
    if (!o.rows.length) return deny(); // gleiche Antwort für fremd und unbekannt
    return { id, max: o.rows[0].max_participants };
  }

  app.get(
    "/api/live-spots/:id/participants",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const { rows } = await pool.query(
        `SELECT lp.id, lp.registered_at, lp.checked_in_at,
                (SELECT p.name FROM profiles p
                 WHERE p.code = lp.participant_code AND p.spot = 'caching' LIMIT 1) AS name_enc
         FROM live_participants lp WHERE lp.live_spot_id = $1
         ORDER BY lp.registered_at ASC, lp.id ASC`,
        [own.id],
      );
      const list = rows.map((r) => ({
        id: r.id,
        name: (r.name_enc && decrypt(r.name_enc)) || "Teilnehmer",
        registered_at: r.registered_at,
        checked_in_at: r.checked_in_at,
      }));
      res.json({
        max_participants: own.max,
        participant_count: list.length,
        checked_in_count: list.filter((p) => p.checked_in_at).length,
        participants: list,
      });
    }),
  );

  app.delete(
    "/api/live-spots/:id/participants/:pid",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const pid = intId(req.params.pid);
      if (pid !== null)
        await pool.query(
          "DELETE FROM live_participants WHERE id = $1 AND live_spot_id = $2",
          [pid, own.id],
        );
      res.json({ success: true });
    }),
  );

  // Neue Runde: Teilnehmerliste leeren
  app.post(
    "/api/live-spots/:id/participants/reset",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const r = await pool.query(
        "DELETE FROM live_participants WHERE live_spot_id = $1",
        [own.id],
      );
      res.json({ success: true, removed: r.rowCount });
    }),
  );

  app.get(
    "/api/live-spots/:id/followers",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const { rows } = await pool.query(
        `SELECT lf.created_at,
                (SELECT p.name FROM profiles p
                 WHERE p.code = lf.follower_code AND p.spot = 'caching' LIMIT 1) AS name_enc
         FROM live_followers lf WHERE lf.live_spot_id = $1
         ORDER BY lf.created_at DESC`,
        [own.id],
      );
      res.json({
        follower_count: rows.length,
        followers: rows.map((r) => ({
          name: (r.name_enc && decrypt(r.name_enc)) || "Follower",
          since: r.created_at,
        })),
      });
    }),
  );

  // ── Öffentliche Seite eines normalen Spots (spot.html) ─────────────────────
  // Öffentlich: nur Spot-Daten. Das Foto nur, wenn freigegeben. Besitzer-Code nur für
  // angemeldete Betrachter (für Chat). Inaktive/unbekannte Spots: 404.
  app.get(
    "/api/spots/:id",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      if (id === null) return notFound(res);
      const viewer = await viewerOf(req.query.code, req.query.token);
      const { rows } = await pool.query(
        `SELECT id, code AS owner_code, name, description, wish_tag AS "wishTag", lat, lng,
                CASE WHEN image_status = 'approved' THEN image ELSE NULL END AS image,
                created_at
         FROM user_spots WHERE id = $1 AND active = true`,
        [id],
      );
      if (!rows.length) return notFound(res);
      const sp = rows[0];
      const out = {
        id: sp.id, name: sp.name, description: sp.description, wishTag: sp.wishTag,
        lat: sp.lat, lng: sp.lng, image: sp.image, created_at: sp.created_at,
        favorite_count: 0, planned_checkins: [],
        is_owner: !!viewer && viewer === sp.owner_code,
      };
      if (viewer && !out.is_owner) out.owner_code = sp.owner_code;
      try {
        out.favorite_count = (
          await pool.query("SELECT COUNT(*)::int AS n FROM spot_favorites WHERE spot_id::text = $1::text", [String(id)])
        ).rows[0].n;
      } catch {}
      try {
        out.planned_checkins = (
          await pool.query(
            `SELECT checkin_at FROM spot_checkins_public
             WHERE spot_id::text = $1::text AND checkin_at > $2 AND status = 'planned'
             ORDER BY checkin_at ASC LIMIT 20`,
            [String(id), Date.now()],
          )
        ).rows.map((r) => Number(r.checkin_at));
      } catch {}
      res.json(out);
    }),
  );

  // ── Event-Bilder (nur der Veranstalter lädt hoch, Freigabe immer durch Admin) ──
  const IMG_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
  function sniffImage(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
    return null;
  }
  const adminOnly = (req, res, next) => {
    const key = req.headers["x-admin-key"] || req.query.key;
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: "Kein Zugriff" });
    next();
  };
  const cleanCaption = (c) => (c ? String(c).trim().slice(0, 100) || null : null);

  app.post(
    "/api/live-spots/:id/images",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const m = typeof req.body.image === "string" ? IMG_RE.exec(req.body.image) : null;
      if (!m) return res.status(400).json({ error: "Bild muss JPEG, PNG oder WebP sein" });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > MAX_IMAGE_BYTES)
        return res.status(413).json({ error: "Bild ist zu groß (max. 700 KB)" });
      if (!sniffImage(buf)) return res.status(400).json({ error: "Ungültige Bilddatei" });
      const out = await tx(async (c) => {
        await c.query("SELECT 1 FROM live_spots WHERE id = $1 FOR UPDATE", [own.id]);
        const n = (await c.query("SELECT COUNT(*)::int AS n FROM live_images WHERE live_spot_id = $1", [own.id])).rows[0].n;
        if (n >= MAX_IMAGES)
          return { status: 400, body: { error: `Maximal ${MAX_IMAGES} Bilder pro Live Spot` } };
        const r = await c.query(
          "INSERT INTO live_images (live_spot_id, image, caption) VALUES ($1,$2,$3) RETURNING id, caption, status, created_at",
          [own.id, req.body.image, cleanCaption(req.body.caption)],
        );
        return { status: 200, body: { success: true, image: r.rows[0] } };
      });
      res.status(out.status).json(out.body);
    }),
  );

  // Liste: Veranstalter sieht alle (mit Bilddaten + Status), alle anderen nur freigegebene (ohne Bilddaten)
  app.get(
    "/api/live-spots/:id/images",
    wrap(async (req, res) => {
      const id = intId(req.params.id);
      if (id === null) return notFound(res);
      const viewer = await viewerOf(req.query.code, req.query.token);
      const v = await pool.query(
        `SELECT (ls.creator_code = $2::text) AS is_owner FROM live_spots ls WHERE ls.id = $1 AND ${visible("$2")}`,
        [id, viewer],
      );
      if (!v.rows.length) return notFound(res);
      const owner = v.rows[0].is_owner === true;
      const { rows } = await pool.query(
        `SELECT id, caption, status, created_at${owner ? ", image" : ""}
         FROM live_images WHERE live_spot_id = $1 ${owner ? "" : "AND status = 'approved'"}
         ORDER BY created_at ASC, id ASC`,
        [id],
      );
      res.json({ is_owner: owner, images: rows });
    }),
  );

  // Bilddatei (nur freigegebene) – für <img src>, gut cachebar
  app.get(
    "/api/live-spots/:id/images/:imgId/raw",
    wrap(async (req, res) => {
      const id = intId(req.params.id), imgId = intId(req.params.imgId);
      if (id === null || imgId === null) return notFound(res);
      const { rows } = await pool.query(
        "SELECT image FROM live_images WHERE id = $1 AND live_spot_id = $2 AND status = 'approved'",
        [imgId, id],
      );
      if (!rows.length) return notFound(res);
      const m = IMG_RE.exec(rows[0].image);
      const buf = m ? Buffer.from(m[2], "base64") : null;
      const type = buf && sniffImage(buf);
      if (!type) return notFound(res);
      res.set({
        "Content-Type": type,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      res.send(buf);
    }),
  );

  app.put(
    "/api/live-spots/:id/images/:imgId",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const imgId = intId(req.params.imgId);
      if (imgId === null) return notFound(res);
      const r = await pool.query(
        "UPDATE live_images SET caption = $1 WHERE id = $2 AND live_spot_id = $3",
        [cleanCaption(req.body.caption), imgId, own.id],
      );
      if (!r.rowCount) return notFound(res);
      res.json({ success: true });
    }),
  );

  app.delete(
    "/api/live-spots/:id/images/:imgId",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const imgId = intId(req.params.imgId);
      if (imgId === null) return notFound(res);
      const r = await pool.query(
        "DELETE FROM live_images WHERE id = $1 AND live_spot_id = $2",
        [imgId, own.id],
      );
      if (!r.rowCount) return notFound(res);
      res.json({ success: true });
    }),
  );

  // Admin: Freigabe
  app.get(
    "/api/admin/pending-live-images",
    adminOnly,
    wrap(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT li.id, li.image, li.caption, li.created_at, ls.name AS spot_name, ls.creator_code AS code
         FROM live_images li JOIN live_spots ls ON ls.id = li.live_spot_id
         WHERE li.status = 'pending' ORDER BY li.created_at ASC`,
      );
      res.json(rows);
    }),
  );
  app.post(
    "/api/admin/live-image-action",
    adminOnly,
    wrap(async (req, res) => {
      const { id, action } = req.body || {};
      const imgId = intId(id);
      if (imgId === null || !["approve", "reject"].includes(action))
        return res.status(400).json({ error: "id und action (approve/reject) erforderlich" });
      const r =
        action === "approve"
          ? await pool.query("UPDATE live_images SET status = 'approved' WHERE id = $1", [imgId])
          : await pool.query("DELETE FROM live_images WHERE id = $1", [imgId]);
      if (!r.rowCount) return res.status(404).json({ error: "Bild nicht gefunden" });
      res.json({ success: true, action, id: imgId });
    }),
  );

  // Abonnenten eines Spots (Angemeldete + Follower, ohne Veranstalter) – VOR dem Löschen holen
  async function audienceOf(spotId, ownerCode) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (ps.endpoint) ps.endpoint, ps.p256dh, ps.auth
       FROM (SELECT follower_code AS code FROM live_followers WHERE live_spot_id = $1
             UNION
             SELECT participant_code FROM live_participants WHERE live_spot_id = $1) u
       JOIN push_subscriptions ps ON ps.code = u.code
       WHERE u.code <> $2
       ORDER BY ps.endpoint`,
      [spotId, ownerCode],
    );
    return rows;
  }

  function pushTo(subs, payload) {
    const body = JSON.stringify(payload);
    for (const f of subs) {
      webpush
        .sendNotification({ endpoint: f.endpoint, keys: { p256dh: f.p256dh, auth: f.auth } }, body)
        .catch(async (err) => {
          if (err && (err.statusCode === 410 || err.statusCode === 404))
            await pool.query("DELETE FROM push_subscriptions WHERE endpoint=$1", [f.endpoint]).catch(() => {});
        });
    }
  }

  // ── Live Spot löschen (Veranstalter): Angemeldete + Follower werden benachrichtigt ──
  app.delete(
    "/api/live-spots/:id",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const code = String((req.body || {}).code);
      const s = await pool.query("SELECT name FROM live_spots WHERE id = $1", [own.id]);
      if (!s.rows.length) return notFound(res);
      const subs = await audienceOf(own.id, code);
      await pool.query("DELETE FROM live_spots WHERE id = $1 AND creator_code = $2", [own.id, code]);
      pushTo(subs, {
        title: `🗑️ ${s.rows[0].name} wurde gelöscht`,
        body: "Der Veranstalter hat diesen Live Spot entfernt.",
        url: "/",
        tag: `live-${own.id}`,
      });
      res.json({ success: true, notified: subs.length });
    }),
  );

  // ── Termin absagen (Veranstalter): Termin weg, Anmeldungen gelöscht ────────
  app.post(
    "/api/live-spots/:id/cancel",
    wrap(async (req, res) => {
      const own = await ownerOnly(req, res);
      if (!own) return;
      const info = await pool.query("SELECT name, creator_code FROM live_spots WHERE id = $1", [own.id]);
      const subs = info.rows.length ? await audienceOf(own.id, info.rows[0].creator_code) : [];
      const out = await tx(async (c) => {
        const u = await c.query(
          `UPDATE live_spots SET starts_at = NULL,
             status = CASE WHEN status = 'planned' THEN 'offline' ELSE status END,
             updated_at = NOW()
           WHERE id = $1 RETURNING id`,
          [own.id],
        );
        const d = await c.query("DELETE FROM live_participants WHERE live_spot_id = $1", [own.id]);
        return { status: 200, body: { success: !!u.rows.length, removed: d.rowCount } };
      });
      if (out.status === 200 && out.body.success)
        pushTo(subs, {
          title: `❌ Termin abgesagt: ${info.rows[0].name}`,
          body: "Der Veranstalter hat den Termin abgesagt. Deine Anmeldung wurde gelöscht.",
          url: `/live-spot.html?id=${own.id}`,
          tag: `live-${own.id}`,
        });
      res.status(out.status).json(out.body);
    }),
  );

  // Offline gehen räumt den Termin mit auf (ersetzt die Route aus server.js)
  app.post(
    "/api/live-spots/:id/gooffline",
    wrap(async (req, res) => {
      const { code, token } = req.body;
      if (!code || !token)
        return res.status(400).json({ error: "code + token erforderlich" });
      if (!(await viewerOf(code, token)))
        return res.status(403).json({ error: "Ungültiger Token" });
      const id = intId(req.params.id);
      if (id !== null)
        await pool.query(
          `UPDATE live_spots SET status='offline', stream_url=NULL, starts_at=NULL, updated_at=NOW()
           WHERE id=$1 AND creator_code=$2`,
          [id, code],
        );
      res.json({ success: true });
    }),
  );

  // Kalenderdatei (.ics) für sichtbare Spots mit Termin
  app.get(
    "/api/live-spots/:id/ics",
    wrap(async (req, res) => {
      const viewer = await viewerOf(req.query.code, req.query.token);
      const id = intId(req.params.id);
      if (id === null) return notFound(res);
      const { rows } = await pool.query(
        `SELECT ls.id, ls.name, ls.location_note, ls.starts_at FROM live_spots ls
         WHERE ls.id = $1 AND ls.starts_at IS NOT NULL AND ${visible("$2")}`,
        [id, viewer],
      );
      if (!rows.length) return notFound(res);
      const r = rows[0];
      const f = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const t = (x) => String(x || "").replace(/[\\;,]/g, (m) => "\\" + m).replace(/\r?\n/g, "\\n");
      const start = new Date(r.starts_at);
      const ics = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SpotMe//Live Spot//DE", "BEGIN:VEVENT",
        `UID:livespot-${r.id}@spotme`, `DTSTAMP:${f(new Date())}`,
        `DTSTART:${f(start)}`, `DTEND:${f(new Date(start.getTime() + 2 * 3600000))}`,
        `SUMMARY:${t(r.name)}`, `LOCATION:${t(r.location_note)}`,
        `URL:${req.protocol}://${req.get("host")}/live-spot.html?id=${r.id}`,
        "END:VEVENT", "END:VCALENDAR",
      ].join("\r\n");
      res.set("Content-Type", "text/calendar; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="live-spot-${r.id}.ics"`);
      res.send(ics);
    }),
  );

  // ── Push beim Live-Gehen ───────────────────────────────────────────────────
  // Follower: nur im Umkreis (wie bisher) und nur, solange der Spot für sie sichtbar ist.
  // Angemeldete: immer (sie haben sich für den Termin angemeldet).
  async function sendLivePush(spot) {
    if (!spot.lat || !spot.lng) return;
    await ready;
    const cur = await pool.query(
      `SELECT max_participants,
              (SELECT COUNT(*)::int FROM live_participants WHERE live_spot_id = $1) AS n
       FROM live_spots WHERE id = $1`,
      [spot.id],
    );
    if (!cur.rows.length) return;
    const full =
      cur.rows[0].max_participants !== null &&
      cur.rows[0].n >= cur.rows[0].max_participants;

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (ps.endpoint)
              u.code, p.last_lat, p.last_lng, ps.endpoint, ps.p256dh, ps.auth,
              EXISTS (SELECT 1 FROM live_participants lp
                      WHERE lp.live_spot_id = $1 AND lp.participant_code = u.code) AS is_participant
       FROM (SELECT follower_code AS code FROM live_followers WHERE live_spot_id = $1
             UNION
             SELECT participant_code FROM live_participants WHERE live_spot_id = $1) u
       JOIN profiles p ON p.code = u.code
       JOIN push_subscriptions ps ON ps.code = u.code
       ORDER BY ps.endpoint`,
      [spot.id],
    );

    const base = {
      body: spot.location_note || "Tippe um den Standort zu sehen.",
      url: `/live-spot.html?id=${spot.id}`,
      tag: `live-${spot.id}`,
    };
    const forFollowers = JSON.stringify({ title: `📡 ${spot.name} ist jetzt live!`, ...base });
    const forParticipants = JSON.stringify({
      title: `🎟️ ${spot.name} ist live – du bist angemeldet`,
      ...base,
    });

    for (const f of rows) {
      if (!f.is_participant) {
        if (full) continue; // voll: Nicht-Teilnehmer erfahren nichts
        if (f.last_lat && f.last_lng) {
          const km = haversineM(+f.last_lat, +f.last_lng, +spot.lat, +spot.lng) / 1000;
          if (km > FOLLOWER_PUSH_KM) continue;
        }
      }
      webpush
        .sendNotification(
          { endpoint: f.endpoint, keys: { p256dh: f.p256dh, auth: f.auth } },
          f.is_participant ? forParticipants : forFollowers,
        )
        .catch(async (err) => {
          if (err && (err.statusCode === 410 || err.statusCode === 404)) {
            await pool
              .query("DELETE FROM push_subscriptions WHERE endpoint=$1", [f.endpoint])
              .catch(() => {});
          }
        });
    }
  }

  return { ready, sendLivePush, CHECKIN_RADIUS_M };
};
