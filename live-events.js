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
    ls.updated_at, ls.max_participants, ${COUNT_SQL} AS participant_count`;

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
         WHERE ls.status = 'online' AND ${visible("$1")}
         ORDER BY ls.updated_at DESC`,
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
        `SELECT ls.status, ls.lat, ls.lng
         FROM live_participants lp JOIN live_spots ls ON ls.id = lp.live_spot_id
         WHERE lp.live_spot_id = $1 AND lp.participant_code = $2`,
        [id, code],
      );
      if (!r.rows.length) return res.status(403).json(noTicket);
      const s = r.rows[0];
      if (s.status !== "online" || s.lat == null || s.lng == null)
        return res.status(400).json({ error: "Der Live Spot ist gerade nicht live." });
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
