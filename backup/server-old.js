// ══════════════════════════════════════════════════════════════════════════════
// SPOTME SERVER v8.4 – PostgreSQL (inkl. SpotCache & Messenger Invites)
//
// Features:
//   • 24h Offline-Sichtbarkeit  → visible_until Timestamp pro Profil
//   • Offline-Nachrichten       → Nachricht hinterlassen wenn Nutzer offline
//   • Dialog-Erkennung          → Sobald Antwort erfolgt, kein Stundenlimit mehr
//   • Ping-Endpunkt             → Für Heartbeat (Render Free Tier)
//   • Spot-Nachrichten          → type, source, spot_type Felder
//   • Dates-Spot                → looking_for Feld
//   • Avatar-Upload             → Profilbilder als Base64 in DB
//   • Avatar-Moderation         → Admin freigeben/ablehnen
//   • Profile Comments          → Story-Kommentare (öffentlich)
//   • SpotCache                 → Geheime Treffpunkte (wishTags/offerTags)
//   • Messenger Invites         → RAM-basierte Einladungen
//
// Setup:
//   npm install pg
//   Render: DATABASE_URL wird automatisch gesetzt wenn du eine Postgres-DB
//           verlinkst. Lokal: DATABASE_URL=postgres://user:pass@localhost/spotme
// ══════════════════════════════════════════════════════════════════════════════

"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const webpush = require("web-push");
const { ExpressPeerServer } = require("peer");
const { Pool } = require("pg");

// ══════════════════════════════════════════════════════════════════════════════
// VERSCHLÜSSELUNG (AES-256-CBC via Node.js crypto)
// CRYPTO_KEY = 64-stelliger Hex-String in Render Environment Variables setzen
// openssl rand -hex 32  →  erzeugt einen sicheren Key
// ══════════════════════════════════════════════════════════════════════════════
const CRYPTO_KEY = process.env.CRYPTO_KEY || null;
const CRYPTO_ALGO = "aes-256-cbc";

function encrypt(text) {
  if (text == null || !CRYPTO_KEY) return text;
  try {
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(CRYPTO_KEY, "hex");
    const cipher = crypto.createCipheriv(CRYPTO_ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(String(text)), cipher.final()]);
    return iv.toString("hex") + ":" + enc.toString("hex");
  } catch (e) {
    console.error("encrypt error:", e.message);
    return text;
  }
}

function decrypt(text) {
  if (text == null || !CRYPTO_KEY || !String(text).includes(":")) return text;
  try {
    const [ivHex, encHex] = String(text).split(":");
    const key = Buffer.from(CRYPTO_KEY, "hex");
    const decipher = crypto.createDecipheriv(
      CRYPTO_ALGO,
      key,
      Buffer.from(ivHex, "hex"),
    );
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, "hex")),
      decipher.final(),
    ]).toString();
  } catch (e) {
    return text;
  }
}

function decryptProfile(p) {
  if (!p) return p;
  const dec = {
    ...p,
    name: decrypt(p.name),
    bio: decrypt(p.bio),
    orientation: decrypt(p.orientation),
    role: decrypt(p.role),
    lookingFor: decrypt(p.lookingFor),
    helpMode: decrypt(p.helpMode),
    helpCategory: decrypt(p.helpCategory),
    category: decrypt(p.category),
  };
  // SpotCache: JSON-Arrays entschlüsseln
  if (p.wish_tags) {
    try {
      dec.wishTags = JSON.parse(decrypt(p.wish_tags) || "[]");
    } catch {
      dec.wishTags = [];
    }
  } else {
    dec.wishTags = null;
  }
  if (p.offer_tags) {
    try {
      dec.offerTags = JSON.parse(decrypt(p.offer_tags) || "[]");
    } catch {
      dec.offerTags = [];
    }
  } else {
    dec.offerTags = null;
  }
  return dec;
}

const app = express();

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.path} from ${req.ip}`,
  );
  next();
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ---------- PeerJS ----------
const server = require("http").createServer(app);
const peerServer = ExpressPeerServer(server, {
  path: "/",
  allow_discovery: true,
  proxied: true,
});
app.use("/peerjs", peerServer);

// ---------- PostgreSQL Pool ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

// ---------- Web Push / VAPID ----------
// Beim ersten Start ohne Env-Vars: Schlüssel einmalig generieren + loggen.
// → In Render unter Environment als VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY eintragen.
// → Danach neu deployen – ab dann sind die Schlüssel stabil.
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  console.log(
    "🔑 VAPID Schlüssel (einmalig generiert – bitte in Render speichern!):",
  );
  console.log("   VAPID_PUBLIC_KEY =", keys.publicKey);
  console.log("   VAPID_PRIVATE_KEY=", keys.privateKey);
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}
webpush.setVapidDetails(
  "mailto:admin@spotme.app",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

// ---------- Konstanten ----------
const OFFLINE_VISIBLE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_MSG_MAX = 280;
const OFFLINE_MSG_RATE_MS = 60 * 60 * 1000;

// ══════════════════════════════════════════════════════════════════════════════
// DATENBANK – Tabellen anlegen (beim Start)
// ══════════════════════════════════════════════════════════════════════════════
async function initDB() {
  // Profiles
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      code          TEXT NOT NULL,
      spot          TEXT NOT NULL DEFAULT 'gay',
      name          TEXT NOT NULL,
      age           INTEGER,
      region        TEXT NOT NULL,
      province      TEXT,
      city          TEXT,
      orientation   TEXT,
      role          TEXT,
      trans         BOOLEAN DEFAULT FALSE,
      crossdresser  BOOLEAN DEFAULT FALSE,
      looking_for   TEXT,
      help_mode     TEXT,
      help_category TEXT,
      category      TEXT,
      bio           TEXT,
      token         TEXT NOT NULL,
      last_seen     BIGINT,
      updated_at    BIGINT NOT NULL,
      visible_until BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (code, spot)
    );
  `);

  // ── WayPoint-Erweiterung: Fragetypen + Coins ──────────────────────
  await pool.query(`
  ALTER TABLE wp_waypoints ADD COLUMN IF NOT EXISTS question_type TEXT NOT NULL DEFAULT 'multiple_choice'
    CHECK (question_type IN ('multiple_choice','freitext','foto'));
  ALTER TABLE wp_waypoints ALTER COLUMN option_a DROP NOT NULL;
  ALTER TABLE wp_waypoints ALTER COLUMN option_b DROP NOT NULL;
  ALTER TABLE wp_waypoints ALTER COLUMN option_c DROP NOT NULL;
  ALTER TABLE wp_waypoints ALTER COLUMN correct_option DROP NOT NULL;
  ALTER TABLE wp_waypoints ADD COLUMN IF NOT EXISTS correct_text TEXT;
`);

  await pool.query(`
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0;
`);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS coin_transactions (
    id         SERIAL PRIMARY KEY,
    code       TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    route_id   INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_ctx_code ON coin_transactions(code);
`);

  // Verifikationen
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verifications (
      id          SERIAL PRIMARY KEY,
      to_code     TEXT NOT NULL,
      to_spot     TEXT NOT NULL DEFAULT 'gay',
      from_code   TEXT NOT NULL,
      type        TEXT NOT NULL CHECK (type IN ('personal','chat')),
      created_at  BIGINT NOT NULL,
      UNIQUE(to_code, to_spot, from_code, type)
    );
  `);

  // Verpasste Anrufe
  await pool.query(`
    CREATE TABLE IF NOT EXISTS missed_calls (
      id          SERIAL PRIMARY KEY,
      recipient   TEXT NOT NULL,
      caller_id   TEXT NOT NULL,
      caller_name TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_missed_recipient ON missed_calls(recipient);
    CREATE INDEX IF NOT EXISTS idx_missed_created   ON missed_calls(created_at);
  `);

  // Offline-Nachrichten
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offline_messages (
      id          SERIAL PRIMARY KEY,
      recipient   TEXT NOT NULL,
      sender_code TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      message     TEXT NOT NULL,
      type        TEXT,
      source      TEXT,
      spot_type   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read        BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_offmsg_recipient ON offline_messages(recipient);
    CREATE INDEX IF NOT EXISTS idx_offmsg_created   ON offline_messages(created_at);
  `);

  // Profile Comments
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_comments (
      id            SERIAL PRIMARY KEY,
      profile_code  TEXT NOT NULL,
      profile_spot  TEXT NOT NULL DEFAULT 'dates',
      sender_code   TEXT NOT NULL,
      sender_name   TEXT NOT NULL,
      message       TEXT NOT NULL CHECK (char_length(message) <= 140),
      created_at    BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pc_profile ON profile_comments(profile_code, profile_spot);
    CREATE INDEX IF NOT EXISTS idx_pc_created ON profile_comments(created_at);
  `);

  // SpotCache v1 (Requests)
  await pool.query(`
  CREATE TABLE IF NOT EXISTS spot_cache_requests (
    id            SERIAL PRIMARY KEY,
    from_code     TEXT NOT NULL,
    to_code       TEXT NOT NULL,
    wish          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    location_lat  DOUBLE PRECISION,
    location_lng  DOUBLE PRECISION,
    unlocked_at   BIGINT,
    created_at    BIGINT NOT NULL,
    UNIQUE(from_code, to_code, wish)
  );
`);

  // SpotCache v2 – User-eigene Geocaching-Spots
  await pool.query(`
  CREATE TABLE IF NOT EXISTS user_spots (
    id           SERIAL PRIMARY KEY,
    code         TEXT NOT NULL,
    lat          DOUBLE PRECISION NOT NULL,
    lng          DOUBLE PRECISION NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    wish_tag     TEXT NOT NULL,
    image        TEXT,
    image_status TEXT DEFAULT 'pending',
    created_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_spots_code ON user_spots(code);
  CREATE INDEX IF NOT EXISTS idx_user_spots_wish ON user_spots(wish_tag);
`);

  // SpotCache v2 – Einladungen mit Zeitfenster
  await pool.query(`
  CREATE TABLE IF NOT EXISTS spot_cache_invites (
    id          SERIAL PRIMARY KEY,
    from_code   TEXT NOT NULL,
    to_code     TEXT NOT NULL,
    spot_id     INTEGER NOT NULL REFERENCES user_spots(id),
    time_start  BIGINT NOT NULL,
    time_end    BIGINT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    checked_in_from BOOLEAN DEFAULT FALSE,
    checked_in_to   BOOLEAN DEFAULT FALSE,
    created_at  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_invites_from ON spot_cache_invites(from_code);
  CREATE INDEX IF NOT EXISTS idx_invites_to ON spot_cache_invites(to_code);
  CREATE INDEX IF NOT EXISTS idx_invites_status ON spot_cache_invites(status);
`);

  // Spalten nachträglich hinzufügen
  try {
    await pool.query(
      `ALTER TABLE offline_messages ADD COLUMN IF NOT EXISTS type TEXT`,
    );
    await pool.query(
      `ALTER TABLE offline_messages ADD COLUMN IF NOT EXISTS source TEXT`,
    );
    await pool.query(
      `ALTER TABLE offline_messages ADD COLUMN IF NOT EXISTS spot_type TEXT`,
    );
    await pool.query(
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS looking_for TEXT`,
    );
    await pool.query(
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS help_mode TEXT`,
    );
    await pool.query(
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS help_category TEXT`,
    );
    await pool.query(
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar TEXT`,
    );
    await pool
      .query(
        `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_status TEXT DEFAULT 'pending'`,
      )
      .catch(() => {});
    await pool.query(
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wish_tags TEXT`,
    );
    await pool.query(
      `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS offer_tags TEXT`,
    );
    await pool
      .query(`ALTER TABLE user_spots ADD COLUMN IF NOT EXISTS image TEXT`)
      .catch(() => {});
    await pool
      .query(`ALTER TABLE user_spots ADD COLUMN IF NOT EXISTS description TEXT`)
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE user_spots ADD COLUMN IF NOT EXISTS image_status TEXT DEFAULT 'pending'`,
      )
      .catch(() => {});
    console.log("✅ v8.4 – Alle Spalten bereit (inkl. SpotCache)");
  } catch (e) {
    console.log(
      "ℹ️ Spalten existieren bereits oder konnten nicht angelegt werden",
    );
  }

  // Wochen-Spots – privater 7-Tage-Spot mit teilbarem Link
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_spots (
      id             SERIAL PRIMARY KEY,
      token          TEXT UNIQUE NOT NULL,
      code           TEXT NOT NULL,
      name           TEXT NOT NULL,
      category       TEXT,
      description    TEXT,
      lat            DOUBLE PRECISION NOT NULL,
      lng            DOUBLE PRECISION NOT NULL,
      meeting_at     BIGINT,
      expires_at     BIGINT NOT NULL,
      created_at     BIGINT NOT NULL,
      checkin_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_token      ON weekly_spots(token);
    CREATE INDEX IF NOT EXISTS idx_weekly_code       ON weekly_spots(code);
    CREATE INDEX IF NOT EXISTS idx_weekly_expires    ON weekly_spots(expires_at);
  `);

  // Push-Subscriptions für Web-Push-Benachrichtigungen
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         SERIAL PRIMARY KEY,
      code       TEXT NOT NULL,
      endpoint   TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(code, endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_push_code ON push_subscriptions(code);
  `);

  // ── WayPoint Caching ─────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wp_routes (
      id          SERIAL PRIMARY KEY,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      difficulty  SMALLINT NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
      published   BOOLEAN NOT NULL DEFAULT false,
      play_count  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wpr_code      ON wp_routes(code);
    CREATE INDEX IF NOT EXISTS idx_wpr_published ON wp_routes(published);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wp_waypoints (
      id             SERIAL PRIMARY KEY,
      route_id       INTEGER NOT NULL REFERENCES wp_routes(id) ON DELETE CASCADE,
      order_index    SMALLINT NOT NULL,
      lat            DOUBLE PRECISION NOT NULL,
      lng            DOUBLE PRECISION NOT NULL,
      question       TEXT NOT NULL,
      option_a       TEXT NOT NULL,
      option_b       TEXT NOT NULL,
      option_c       TEXT NOT NULL,
      correct_option CHAR(1) NOT NULL CHECK (correct_option IN ('a','b','c')),
      UNIQUE(route_id, order_index)
    );
    CREATE INDEX IF NOT EXISTS idx_wpw_route ON wp_waypoints(route_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wp_progress (
      id                  SERIAL PRIMARY KEY,
      route_id            INTEGER NOT NULL,
      player_code         TEXT NOT NULL,
      current_index       SMALLINT NOT NULL DEFAULT 0,
      started_at          BIGINT NOT NULL,
      last_activity_at    BIGINT NOT NULL,
      UNIQUE(route_id, player_code)
    );
    CREATE INDEX IF NOT EXISTS idx_wpp_player ON wp_progress(player_code);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wp_completions (
      id           SERIAL PRIMARY KEY,
      route_id     INTEGER NOT NULL,
      player_code  TEXT NOT NULL,
      time_seconds INTEGER NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(route_id, player_code)
    );
    CREATE INDEX IF NOT EXISTS idx_wpc_route  ON wp_completions(route_id);
    CREATE INDEX IF NOT EXISTS idx_wpc_player ON wp_completions(player_code);
  `);

  // Live Spots – mobile Profil-Spots für Creator die sich bewegen
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_spots (
      id             SERIAL PRIMARY KEY,
      token          TEXT UNIQUE NOT NULL,
      creator_code   TEXT NOT NULL,
      name           TEXT NOT NULL,
      description    TEXT,
      category       TEXT,
      avatar         TEXT,
      status         TEXT NOT NULL DEFAULT 'offline',
      lat            DOUBLE PRECISION,
      lng            DOUBLE PRECISION,
      location_note  TEXT,
      follower_count INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ls_creator ON live_spots(creator_code);
    CREATE INDEX IF NOT EXISTS idx_ls_status  ON live_spots(status);
    CREATE INDEX IF NOT EXISTS idx_ls_token   ON live_spots(token);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_followers (
      id           SERIAL PRIMARY KEY,
      live_spot_id INTEGER NOT NULL REFERENCES live_spots(id) ON DELETE CASCADE,
      follower_code TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(live_spot_id, follower_code)
    );
    CREATE INDEX IF NOT EXISTS idx_lf_spot   ON live_followers(live_spot_id);
    CREATE INDEX IF NOT EXISTS idx_lf_follower ON live_followers(follower_code);
  `);

  // Letzter bekannter Standort der Nutzer – für 10km Push-Filter
  await pool
    .query(
      `
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_lat  DOUBLE PRECISION;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_lng  DOUBLE PRECISION;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
  `,
    )
    .catch(() => {});

  console.log("✅ Datenbank-Tabellen bereit");
}

// ---------- Standort-Cache (RAM, 2-Min TTL) ----------
const locationCache = new Map();

// Zähler der verfolgt wie oft der Interval bereits gefeuert hat.
// Damit können wir seltene Aufgaben (z.B. täglich) von häufigen
// (z.B. alle 2 Minuten) trennen – ohne zwei separate setInterval-Timer.
let cleanupTickCount = 0;

setInterval(async () => {
  const now = Date.now();
  cleanupTickCount++;

  // ── ALLE 2 MINUTEN: RAM-Cache bereinigen ────────────────────────────────
  // Der locationCache wächst mit jedem Online-Nutzer – ohne Cleanup würde
  // er über Zeit den Arbeitsspeicher des Servers füllen.
  for (const [key, data] of locationCache.entries()) {
    if (now - data.ts > 120000) locationCache.delete(key);
  }

  // ── ALLE 2 MINUTEN: Einladungen im RAM bereinigen ───────────────────────
  // Einladungen älter als 2 Stunden aus dem RAM löschen (bereits vorhanden)
  for (const code of Object.keys(invites)) {
    invites[code] = invites[code].filter(
      (i) => now - i.ts < 2 * 60 * 60 * 1000,
    );
    if (invites[code].length === 0) delete invites[code];
  }

  // ── ALLE 7 TAGE (= 5040 Ticks × 2 Min): Datenbank-Cleanup ──────────────
  // Wir führen schwere Datenbankoperationen nicht alle 2 Minuten aus,
  // sondern nur täglich. 720 Ticks × 2 Minuten = genau 24 Stunden.
  // Der Modulo-Operator % gibt den Rest einer Division zurück:
  // cleanupTickCount % 720 === 0 ist nur dann true wenn der Zähler
  // ein genaues Vielfaches von 720 ist – also genau alle 24 Stunden.
  const isDaily = cleanupTickCount % 720 === 0;

  if (isDaily) {
    console.log("🗓️ Täglicher Datenbank-Cleanup startet…");

    // ── Abgelaufene Einladungen auf 'expired' setzen ──────────────────────
    // Wir löschen sie NICHT sofort – der Nutzer soll seine vergangenen
    // Treffen noch bis zu 30 Tage sehen können (Strategie 2).
    try {
      const r = await pool.query(
        `UPDATE spot_cache_invites
         SET status = 'expired'
         WHERE time_end < $1
           AND status IN ('pending', 'accepted')`,
        [now],
      );
      if (r.rowCount > 0)
        console.log(`🗂️ ${r.rowCount} Einladungen auf 'expired' gesetzt`);
    } catch (e) {
      console.error("Cleanup invites (expire):", e.message);
    }

    // Alte Wochen‑Spots löschen (abgelaufen)
    try {
      const r = await pool.query(
        `DELETE FROM weekly_spots WHERE expires_at < $1`,
        [Date.now()],
      );
      if (r.rowCount > 0)
        console.log(`🧹 ${r.rowCount} abgelaufene Wochen-Spots gelöscht`);
    } catch (e) {
      console.error("Cleanup weekly_spots:", e.message);
    }

    // ── Wirklich alte Einladungen endgültig löschen (>30 Tage) ───────────
    // Erst nach 30 Tagen werden die archivierten Einladungen wirklich
    // aus der Datenbank entfernt. Das hält die Tabelle langfristig klein.
    try {
      const cutoff = now - 30 * 24 * 60 * 60 * 1000;
      const r = await pool.query(
        `DELETE FROM spot_cache_invites
         WHERE status = 'expired'
           AND time_end < $1`,
        [cutoff],
      );
      if (r.rowCount > 0)
        console.log(`🗑️ ${r.rowCount} alte Einladungen gelöscht (>30 Tage)`);
    } catch (e) {
      console.error("Cleanup invites (delete):", e.message);
    }

    // ── Alte Missed Calls löschen ─────────────────────────────────────────
    try {
      const r = await pool.query(
        `DELETE FROM missed_calls WHERE created_at < NOW() - INTERVAL '7 days'`,
      );
      if (r.rowCount > 0)
        console.log(`🧹 ${r.rowCount} alte Missed Calls gelöscht`);
    } catch (e) {
      console.error("Cleanup missed_calls:", e.message);
    }

    // ── Alte Offline-Nachrichten löschen ──────────────────────────────────
    try {
      const r = await pool.query(
        `DELETE FROM offline_messages WHERE created_at < NOW() - INTERVAL '7 days'`,
      );
      if (r.rowCount > 0)
        console.log(`🧹 ${r.rowCount} alte Offline-Nachrichten gelöscht`);
    } catch (e) {
      console.error("Cleanup offline_messages:", e.message);
    }

    // ── Inaktive Profile löschen ──────────────────────────────────────────
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    try {
      const r = await pool.query(
        `DELETE FROM profiles
         WHERE visible_until < $1
           AND COALESCE(last_seen, updated_at) < $2`,
        [now, thirtyDaysAgo],
      );
      if (r.rowCount > 0)
        console.log(`🧹 ${r.rowCount} inaktive Profile gelöscht`);
    } catch (e) {
      console.error("Cleanup profiles:", e.message);
    }

    console.log("✅ Täglicher Cleanup abgeschlossen");
  }
}, 120000); // alle 2 Minuten

// ---------- Antispam ----------
function sanitizeMessage(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/https?:\/\/\S+/gi, "[Link entfernt]")
    .replace(/\S+@\S+\.\S+/gi, "[E-Mail entfernt]")
    .slice(0, OFFLINE_MSG_MAX)
    .trim();
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNITY PROFILE
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/profiles", async (req, res) => {
  const spot = req.query.spot || "gay";
  const now = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT code, name, age, region, province, city,
              orientation, role, trans, crossdresser,
              looking_for AS "lookingFor",
              help_mode AS "helpMode",
              help_category AS "helpCategory",
              category, bio,
              wish_tags, offer_tags,
              last_seen, updated_at AS ts, visible_until,
              (COALESCE(last_seen, 0) > $2) AS is_online,
              (SELECT COUNT(*) FROM profile_comments WHERE profile_code = p.code AND profile_spot = p.spot) AS comment_count
       FROM profiles p
       WHERE spot = $1 AND visible_until > $2
       ORDER BY is_online DESC, updated_at DESC`,
      [spot, now],
    );
    res.json(
      rows.map((r) => ({
        ...decryptProfile(r),
        commentCount: parseInt(r.comment_count) || 0,
      })),
    );
  } catch (e) {
    console.error("GET /api/profiles:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.post("/api/profile", async (req, res) => {
  const {
    code,
    name,
    age,
    region,
    province,
    city,
    orientation,
    role,
    trans,
    crossdresser,
    category,
    bio,
    lookingFor,
    helpMode,
    helpCategory,
    wishTags,
    offerTags,
    avatar, // ← NEU: optional Base64‑Avatar
    token,
    spot = "gay",
  } = req.body;

  if (!code || !name || !region) {
    return res.status(400).json({ error: "Pflichtfelder: code, name, region" });
  }

  const now = Date.now();
  const visibleUntil = now + OFFLINE_VISIBLE_MS;

  try {
    const existing = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2",
      [code, spot],
    );

    let globalToken = null;
    if (!existing.rows.length || !existing.rows[0]?.token) {
      const gc = await pool.query(
        "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
        [code],
      );
      if (gc.rows.length > 0) globalToken = gc.rows[0].token;
    }

    let profileToken;

    if (existing.rows.length > 0) {
      // UPDATE
      const storedToken = existing.rows[0].token || globalToken;
      if (!token) {
        profileToken = storedToken || crypto.randomBytes(32).toString("hex");
      } else {
        const allTok = await pool.query(
          "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
          [code],
        );
        const tokenOk = allTok.rows.some((r) => r.token === token);
        if (storedToken && !tokenOk) {
          return res.status(403).json({ error: "Ungültiger Token" });
        }
        profileToken = token;
      }

      await pool.query(
        `UPDATE profiles SET
          name=$1, age=$2, region=$3, province=$4, city=$5,
          orientation=$6, role=$7, trans=$8, crossdresser=$9,
          looking_for=$10,
          help_mode=$11, help_category=$12,
          category=$13, bio=$14,
          wish_tags=$15, offer_tags=$16,
          avatar        = COALESCE($21, avatar),
          avatar_status = CASE WHEN $21 IS NOT NULL THEN 'pending' ELSE avatar_status END,
          updated_at=$17, visible_until=$18
         WHERE code=$19 AND spot=$20`,
        [
          encrypt(name),
          age || null,
          region,
          province || null,
          city || null,
          encrypt(orientation) || null,
          encrypt(role) || null,
          !!trans,
          !!crossdresser,
          encrypt(lookingFor) || null,
          encrypt(helpMode) || null,
          encrypt(helpCategory) || null,
          encrypt(category) || null,
          encrypt(bio) || null,
          encrypt(JSON.stringify(wishTags || [])),
          encrypt(JSON.stringify(offerTags || [])),
          now,
          visibleUntil,
          code,
          spot,
          avatar || null, // $21
        ],
      );
    } else {
      // INSERT
      profileToken = crypto.randomBytes(32).toString("hex");
      await pool.query(
        `INSERT INTO profiles
          (code, spot, name, age, region, province, city,
           orientation, role, trans, crossdresser, looking_for,
           help_mode, help_category, category, bio,
           wish_tags, offer_tags,
           avatar, avatar_status,
           token, updated_at, visible_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          code,
          spot,
          encrypt(name),
          age || null,
          region,
          province || null,
          city || null,
          encrypt(orientation) || null,
          encrypt(role) || null,
          !!trans,
          !!crossdresser,
          encrypt(lookingFor) || null,
          encrypt(helpMode) || null,
          encrypt(helpCategory) || null,
          encrypt(category) || null,
          encrypt(bio) || null,
          encrypt(JSON.stringify(wishTags || [])),
          encrypt(JSON.stringify(offerTags || [])),
          avatar || null,
          avatar ? "pending" : null,
          profileToken,
          now,
          visibleUntil,
        ],
      );
    }

    res.json({ success: true, token: profileToken, visibleUntil });
  } catch (e) {
    console.error("POST /api/profile:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.delete("/api/profile/:code", async (req, res) => {
  const { code } = req.params;
  const token = req.body?.token || req.headers["x-spotme-token"];
  const spot = req.body?.spot || req.query.spot || "gay";

  try {
    const existing = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2",
      [code, spot],
    );
    if (!existing.rows.length)
      return res.status(404).json({ error: "Nicht gefunden" });

    const allTokens = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    const tokenValid = allTokens.rows.some((r) => r.token === token);
    if (!token || !tokenValid) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }

    await pool.query(
      "UPDATE profiles SET visible_until = 0 WHERE code = $1 AND spot = $2",
      [code, spot],
    );
    locationCache.delete(code + ":" + spot);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/profile:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/profile/:code", async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || "gay";
  try {
    const { rows } = await pool.query(
      `SELECT code, name, age, region, province, city,
              orientation, role, trans, crossdresser,
              looking_for AS "lookingFor",
              category, bio,
              wish_tags, offer_tags,
              updated_at AS ts, visible_until
       FROM profiles WHERE code = $1 AND spot = $2`,
      [code, spot],
    );
    if (!rows.length) return res.status(404).json({ error: "Nicht gefunden" });
    res.json(decryptProfile(rows[0]));
  } catch (e) {
    console.error("GET /api/profile/:code:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AVATAR UPLOAD / ABRUF / LÖSCHEN
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/avatar", async (req, res) => {
  const { code, token, avatar, spot = "caching" } = req.body;

  if (!code || !token || !avatar) {
    return res
      .status(400)
      .json({ error: "code, token und avatar (Base64) erforderlich" });
  }

  try {
    // Token über alle Spots dieses Codes prüfen
    const auth = await pool.query(
      "SELECT token, spot FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    const tokenValid = auth.rows.some((r) => r.token === token);
    if (!auth.rows.length || !tokenValid) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
  } catch (e) {
    return res.status(500).json({ error: "Token-Prüfung fehlgeschlagen" });
  }

  if (avatar.length > 1_400_000) {
    return res.status(413).json({ error: "Bild zu groß (max. 1 MB)" });
  }

  if (!avatar.startsWith("data:image/")) {
    return res
      .status(400)
      .json({ error: "Nur Base64-Bilder erlaubt (data:image/...)" });
  }

  const mimeMatch = avatar.match(/^data:(image\/[a-z+]+);base64,/);
  if (!mimeMatch) {
    return res.status(400).json({ error: "Ungültiges Base64-Format" });
  }

  const mimeType = mimeMatch[1];
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowed.includes(mimeType)) {
    return res.status(400).json({ error: `Nur ${allowed.join(", ")} erlaubt` });
  }

  try {
    // Auf allen Spots dieses Codes updaten
    await pool.query(
      "UPDATE profiles SET avatar = $1, avatar_status = $2, updated_at = $3 WHERE code = $4 AND spot = $5",
      [avatar, "pending", Date.now(), code, spot],
    );
    console.log(
      `🖼️ Avatar hochgeladen (pending): ${code} (${spot}) – ${(avatar.length / 1024).toFixed(0)} KB`,
    );
    res.json({
      success: true,
      mimeType,
      status: "pending",
      message: "Avatar wird geprüft und bald freigegeben",
    });
  } catch (e) {
    console.error("POST /api/avatar:", e.message);
    res.status(500).json({ error: "Fehler beim Speichern" });
  }
});

app.get("/api/avatar/:code", async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || "gay";

  try {
    const { rows } = await pool.query(
      "SELECT avatar, avatar_status FROM profiles WHERE code = $1 AND spot = $2 AND avatar IS NOT NULL",
      [code, spot],
    );

    if (!rows.length || !rows[0].avatar) {
      return res.status(404).json({ error: "Kein Avatar" });
    }

    if (rows[0].avatar_status !== "approved") {
      return res.status(404).json({
        error: "Avatar noch nicht freigegeben",
        status: rows[0].avatar_status || "pending",
      });
    }

    res.set("Cache-Control", "public, max-age=3600");
    res.json({ avatar: rows[0].avatar });
  } catch (e) {
    console.error("GET /api/avatar:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.delete("/api/avatar/:code", async (req, res) => {
  const { code } = req.params;
  const token = req.body?.token || req.headers["x-spotme-token"];
  const spot = req.body?.spot || "caching";

  if (!token) {
    return res.status(401).json({ error: "Token fehlt" });
  }

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    const tokenValid = auth.rows.some((r) => r.token === token);
    if (!auth.rows.length || !tokenValid) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }

    await pool.query(
      "UPDATE profiles SET avatar = NULL, avatar_status = NULL, updated_at = $1 WHERE code = $2 AND spot = $3",
      [Date.now(), code, spot],
    );
    console.log(`🗑️ Avatar gelöscht: ${code} (${spot})`);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/avatar:", e.message);
    res.status(500).json({ error: "Fehler beim Löschen" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE-STANDORT (RAM, 2-Min TTL)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/location", (req, res) => {
  const { code, lat, lng, spot = "gay" } = req.body;
  if (!code || lat == null || lng == null) {
    return res.status(400).json({ error: "Fehlende Felder" });
  }
  locationCache.set(code + ":" + spot, { lat, lng, ts: Date.now() });
  res.json({ success: true });
});

app.get("/api/location/:code", (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || "gay";
  const data = locationCache.get(code + ":" + spot);
  if (!data || Date.now() - data.ts > 120000) {
    return res.status(404).json({ error: "Standort nicht verfügbar" });
  }
  res.json({ lat: data.lat, lng: data.lng });
});

// ══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT & ONLINE-STATUS
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/heartbeat", async (req, res) => {
  const { code, spot = "gay" } = req.body;
  if (!code) return res.status(400).json({ error: "Code fehlt" });
  const now = Date.now();
  const visibleUntil = now + OFFLINE_VISIBLE_MS;
  try {
    await pool.query(
      `UPDATE profiles
       SET last_seen = $1,
           visible_until = GREATEST(visible_until, $2)
       WHERE code = $3 AND spot = $4`,
      [now, visibleUntil, code, spot],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/online/:code", async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || "gay";
  try {
    const { rows } = await pool.query(
      "SELECT last_seen, visible_until FROM profiles WHERE code = $1 AND spot = $2",
      [code, spot],
    );
    if (!rows.length) return res.json({ online: false, visible: false });
    const now = Date.now();
    const online =
      rows[0].last_seen && now - Number(rows[0].last_seen) < 120000;
    const visible = Number(rows[0].visible_until) > now;
    res.json({
      online: !!online,
      visible,
      lastSeen: Number(rows[0].last_seen),
    });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VERIFIKATIONEN
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/verify", async (req, res) => {
  const { fromCode, toCode, type, spot = "gay" } = req.body;
  if (!fromCode || !toCode || !type) {
    return res.status(400).json({ error: "Felder fehlen" });
  }
  try {
    await pool.query(
      `INSERT INTO verifications (to_code, to_spot, from_code, type, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (to_code, to_spot, from_code, type) DO NOTHING`,
      [toCode, spot, fromCode, type, Date.now()],
    );
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/verify:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/verifications/:code", async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || "gay";
  try {
    const { rows } = await pool.query(
      `SELECT from_code AS "from", type, created_at AS ts
       FROM verifications
       WHERE to_code = $1 AND to_spot = $2
       ORDER BY created_at DESC`,
      [code, spot],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VERPASSTE ANRUFE
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/missed-call", async (req, res) => {
  const { recipient, callerId, callerName } = req.body;
  if (!recipient || !callerId || !callerName) {
    return res.status(400).json({ error: "Fehlende Felder" });
  }
  try {
    await pool.query(
      `INSERT INTO missed_calls (recipient, caller_id, caller_name) VALUES ($1, $2, $3)`,
      [recipient, callerId, encrypt(callerName)],
    );
    await pool.query(
      `DELETE FROM missed_calls WHERE id IN (
         SELECT id FROM missed_calls WHERE recipient = $1
         ORDER BY created_at DESC OFFSET 500
       )`,
      [recipient],
    );
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/missed-call:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/missed-calls/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT caller_id AS "callerId", caller_name AS "callerName",
              created_at AS timestamp
       FROM missed_calls WHERE recipient = $1
       ORDER BY created_at DESC LIMIT 50`,
      [code],
    );
    res.json(rows.map((r) => ({ ...r, callerName: decrypt(r.callerName) })));
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// OFFLINE-NACHRICHTEN (private Kurznachrichten)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/offline-message", async (req, res) => {
  const { recipient, senderCode, senderName, message, type, source, spotType } =
    req.body;

  if (!recipient || !senderCode || !senderName || !message) {
    return res.status(400).json({ error: "Fehlende Felder" });
  }
  if (recipient === senderCode) {
    return res.status(400).json({ error: "Keine Nachricht an sich selbst" });
  }

  const clean = sanitizeMessage(message);
  if (!clean.length) {
    return res
      .status(400)
      .json({ error: "Nachricht ist leer nach Bereinigung" });
  }

  try {
    const dialogCheck = await pool.query(
      `SELECT id FROM offline_messages 
       WHERE sender_code = $1 AND recipient = $2
       LIMIT 1`,
      [recipient, senderCode],
    );

    if (dialogCheck.rows.length === 0) {
      const rateMinutes = Math.ceil(OFFLINE_MSG_RATE_MS / 60000);
      const rateCheck = await pool.query(
        `SELECT id FROM offline_messages
         WHERE sender_code = $1 AND recipient = $2
           AND created_at > NOW() - INTERVAL '${rateMinutes} minutes'
         LIMIT 1`,
        [senderCode, recipient],
      );
      if (rateCheck.rows.length > 0) {
        return res.status(429).json({
          error: `Maximal 1 Nachricht pro ${rateMinutes > 1 ? rateMinutes + " Minuten" : "Minute"} für die erste Kontaktaufnahme`,
        });
      }
    }

    const countCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM offline_messages WHERE recipient = $1 AND read = FALSE`,
      [recipient],
    );
    if (Number(countCheck.rows[0].cnt) >= 50) {
      return res.status(429).json({ error: "Postfach des Empfängers voll" });
    }

    await pool.query(
      `INSERT INTO offline_messages (recipient, sender_code, sender_name, message, type, source, spot_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        recipient,
        senderCode,
        encrypt(senderName.slice(0, 50)),
        encrypt(clean),
        type || null,
        source || null,
        spotType || null,
      ],
    );

    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/offline-message:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/offline-messages/:code", async (req, res) => {
  const { code } = req.params;
  const token = req.query.token || req.headers["x-spotme-token"];
  const spot = req.query.spot || "gay";

  if (!token) return res.status(401).json({ error: "Token fehlt" });

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2",
      [code, spot],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }

    const { rows } = await pool.query(
      `SELECT id, sender_code AS "senderCode", sender_name AS "senderName",
              message, type, source, spot_type AS "spotType",
              created_at AS timestamp, read
       FROM offline_messages
       WHERE recipient = $1 AND spot_type = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [code, spot],
    );
    res.json(
      rows.map((r) => ({
        ...r,
        senderName: decrypt(r.senderName),
        message: decrypt(r.message),
      })),
    );
  } catch (e) {
    console.error("GET /api/offline-messages:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CHAT MESSENGER (SpotCaching – leichtgewichtig)
// Nutzt dieselbe offline_messages Tabelle, aber mit spot_type='caching_chat'
// Kein Token erforderlich – Sicherheit über Profil-Existenz-Check
// ══════════════════════════════════════════════════════════════════════════════

// ── Nachricht senden ─────────────────────────────────────────────────────────
// Jeder der ein Profil hat kann eine Nachricht schicken.
// Das verhindert anonymen Spam ohne einen Login zu erzwingen.
app.post("/api/message", async (req, res) => {
  const { recipient, sender_code, sender_name, message, spot_type } = req.body;

  // Pflichtfelder prüfen
  if (!recipient || !sender_code || !message) {
    return res
      .status(400)
      .json({ error: "recipient, sender_code und message sind Pflicht" });
  }

  // Selbst-Nachrichten verhindern
  if (sender_code === recipient) {
    return res
      .status(400)
      .json({ error: "Nachrichten an sich selbst nicht erlaubt" });
  }

  // Nachricht bereinigen – Links und E-Mails entfernen, auf 280 Zeichen kürzen
  const clean = sanitizeMessage(message);
  if (!clean.length) {
    return res.status(400).json({ error: "Nachricht ist leer oder ungültig" });
  }

  try {
    // Sicherheits-Check: Hat der Absender ein Profil im System?
    // Das verhindert dass anonyme Bots Nachrichten schicken können.
    // Profil muss im caching-Spot existieren.
    const senderExists = await pool.query(
      `SELECT 1 FROM profiles WHERE code = $1 AND spot = 'caching' LIMIT 1`,
      [sender_code],
    );
    if (!senderExists.rows.length) {
      return res.status(403).json({ error: "Absender hat kein Profil" });
    }

    // Postfach-Limit: maximal 100 ungelesene Chat-Nachrichten pro Empfänger
    // Das verhindert Spam auch wenn jemand ein Profil hat
    const countCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM offline_messages
       WHERE recipient = $1 AND spot_type = 'caching_chat' AND read = FALSE`,
      [recipient],
    );
    if (Number(countCheck.rows[0].cnt) >= 100) {
      return res.status(429).json({ error: "Postfach des Empfängers voll" });
    }

    // Nachricht speichern
    await pool.query(
      `INSERT INTO offline_messages
         (recipient, sender_code, sender_name, message, spot_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        recipient,
        sender_code,
        encrypt(sender_name?.slice(0, 50) || sender_code),
        encrypt(clean),
        spot_type || "caching_chat",
      ],
    );

    console.log(`💬 Chat: ${sender_code} → ${recipient}`);
    // Push-Benachrichtigung an Empfänger (fire-and-forget)
    sendPushToCode(
      recipient,
      "💬 Neue Nachricht",
      `${sender_name || sender_code}: ${clean.slice(0, 80)}`,
      "/",
    );
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/message:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Nachrichten abrufen ───────────────────────────────────────────────────────
// Gibt alle Chat-Nachrichten für einen Empfänger zurück.
// Optional: ?spot_type=caching_chat für gefilterten Abruf.
// Nach dem Abrufen werden die Nachrichten als "gelesen" markiert –
// wie ein Briefkasten der geleert wird wenn man die Post holt.
app.get("/api/messages/:code", async (req, res) => {
  const { code } = req.params;
  const spot_type = req.query.spot_type || "caching_chat";

  try {
    // Nachrichten der letzten 48 Stunden abrufen
    // Ältere Nachrichten sind im localStorage bereits gespeichert
    const { rows } = await pool.query(
      `SELECT id, sender_code, sender_name, message, spot_type, created_at
       FROM offline_messages
       WHERE recipient = $1
         AND spot_type = $2
         AND read = FALSE
         AND created_at > NOW() - INTERVAL '48 hours'
       ORDER BY created_at ASC`,
      [code, spot_type],
    );

    // Als gelesen markieren damit beim nächsten Poll keine Duplikate kommen
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      await pool.query(
        "UPDATE offline_messages SET read = TRUE WHERE id = ANY($1)",
        [ids],
      );
      console.log(`📬 ${rows.length} Chat-Nachrichten abgerufen für ${code}`);
    }

    // Nachrichten entschlüsseln bevor sie ans Frontend geschickt werden
    res.json(
      rows.map((r) => ({
        ...r,
        sender_name: decrypt(r.sender_name),
        message: decrypt(r.message),
      })),
    );
  } catch (e) {
    console.error("GET /api/messages:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.delete("/api/offline-message/:id", async (req, res) => {
  const { id } = req.params;
  const { code, token, spot = "gay" } = req.body;

  if (!code || !token) return res.status(401).json({ error: "Token fehlt" });

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2",
      [code, spot],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    await pool.query(
      "UPDATE offline_messages SET read = TRUE WHERE id = $1 AND recipient = $2",
      [id, code],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.delete("/api/offline-messages/:code", async (req, res) => {
  const { code } = req.params;
  const token = req.body?.token || req.headers["x-spotme-token"];
  const spot = req.body?.spot || "gay";

  if (!token) return res.status(401).json({ error: "Token fehlt" });

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2",
      [code, spot],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    await pool.query(
      "UPDATE offline_messages SET read = TRUE WHERE recipient = $1",
      [code],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PROFILE COMMENTS (Story-Kommentare)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/profile-comment", async (req, res) => {
  const {
    profileCode,
    profileSpot = "dates",
    senderCode,
    senderName,
    message,
  } = req.body;

  if (!profileCode || !senderCode || !senderName || !message) {
    return res.status(400).json({
      error: "profileCode, senderCode, senderName, message erforderlich",
    });
  }

  const clean = message.trim().slice(0, 140);
  if (!clean.length) {
    return res.status(400).json({ error: "Nachricht ist leer" });
  }

  if (/https?:\/\/|www\./i.test(clean)) {
    return res.status(400).json({ error: "Keine Links erlaubt" });
  }

  try {
    await pool.query(
      `INSERT INTO profile_comments (profile_code, profile_spot, sender_code, sender_name, message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        profileCode,
        profileSpot,
        senderCode,
        encrypt(senderName.slice(0, 50)),
        encrypt(clean),
        Date.now(),
      ],
    );

    console.log(
      `💬 Kommentar: ${senderName} → ${profileCode}: "${clean.slice(0, 30)}..."`,
    );
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/profile-comment:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/profile-comments/:code", async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || "dates";

  try {
    const { rows } = await pool.query(
      `SELECT id, sender_code AS "senderCode", sender_name AS "senderName",
              message, created_at AS "createdAt"
       FROM profile_comments
       WHERE profile_code = $1 AND profile_spot = $2
       ORDER BY created_at DESC
       LIMIT 999`,
      [code, spot],
    );
    res.json(
      rows.map((r) => ({
        ...r,
        senderName: decrypt(r.senderName),
        message: decrypt(r.message),
      })),
    );
  } catch (e) {
    console.error("GET /api/profile-comments:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.delete("/api/profile-comment/:id", async (req, res) => {
  const { id } = req.params;
  const { code, token, spot = "dates" } = req.body;

  if (!code || !token) {
    return res.status(401).json({ error: "Token fehlt" });
  }

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2",
      [code, spot],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res
        .status(403)
        .json({ error: "Nur der Profilinhaber kann Kommentare löschen" });
    }

    const comment = await pool.query(
      "SELECT id FROM profile_comments WHERE id = $1 AND profile_code = $2 AND profile_spot = $3",
      [id, code, spot],
    );
    if (!comment.rows.length) {
      return res.status(404).json({ error: "Kommentar nicht gefunden" });
    }

    await pool.query("DELETE FROM profile_comments WHERE id = $1", [id]);
    console.log(`🗑️ Kommentar gelöscht: ID ${id} von Profil ${code}`);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/profile-comment:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EINLADUNGEN (Messenger – RAM)
// ══════════════════════════════════════════════════════════════════════════════

const invites = {}; // { empfaengerCode: [{ from, to, ts, room }] }

// Cleanup: Einladungen nach 2 Stunden löschen
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(invites)) {
    invites[code] = invites[code].filter(
      (i) => now - i.ts < 2 * 60 * 60 * 1000,
    );
    if (invites[code].length === 0) delete invites[code];
  }
}, 60000);

// Einladung zum Messenger

app.post("/api/invites/send", async (req, res) => {
  // time_start und time_end aus dem Body lesen – das war vorher vergessen
  const { from, to, spot_id, time_start, time_end } = req.body;

  if (!from || !to || from.length !== 6 || to.length !== 6) {
    return res.status(400).json({ error: "Ungültige Codes" });
  }
  if (from === to) {
    return res.status(400).json({ error: "Selbst-Einladung nicht möglich" });
  }

  // ── RAM (wie bisher, aber jetzt MIT Zeitdaten) ──────────────────────────
  if (!invites[to]) invites[to] = [];
  const exists = invites[to].find((i) => i.from === from);
  if (!exists) {
    const room = [from, to].sort().join("-");
    invites[to].push({
      from,
      to,
      ts: Date.now(),
      room,
      // NEU: Zeitfenster mitspeichern damit der RAM-Kanal auch die Zeit kennt
      time_start: time_start || Date.now(),
      time_end: time_end || Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    console.log(`📨 Einladung: ${from} → ${to} (Raum ${room})`);
  }

  // ── Datenbank (nur wenn spot_id vorhanden) ──────────────────────────────
  if (spot_id) {
    try {
      // Fallback-Werte falls kein Zeitfenster mitgeschickt wurde –
      // das kann passieren wenn jemand den Chat-Button ohne Modal nutzt
      const ts = time_start || Date.now();
      const te = time_end || ts + 7 * 24 * 60 * 60 * 1000;

      await pool.query(
        `INSERT INTO spot_cache_invites
           (from_code, to_code, spot_id, time_start, time_end, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         ON CONFLICT DO NOTHING`,
        [from, to, spot_id, ts, te, Date.now()],
        //                   ↑  ↑
        // Jetzt kommen die echten Zeitwerte aus dem Frontend-Modal,
        // nicht mehr der berechnete Standardwert vom Server
      );
    } catch (e) {
      console.error("DB invite error:", e.message);
    }
  }

  res.json({ success: true });
});

// Liefert alle Einladungen für einen Nutzer (als Sender UND Empfänger)
// inklusive Status – das ist der Unterschied zum RAM-Endpunkt
app.get("/api/spotcache/invites/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      // Wir joinieren die profiles-Tabelle ZWEIMAL – einmal für den Sender (pf)
      // und einmal für den Empfänger (pt). LEFT JOIN statt INNER JOIN damit die
      // Einladung auch erscheint wenn ein Profil zwischenzeitlich gelöscht wurde.
      // Die Namen sind verschlüsselt gespeichert und werden unten entschlüsselt.
      `SELECT i.*,
              u.name  AS spot_name,
              u.lat,
              u.lng,
              pf.name AS from_name_enc,
              pt.name AS to_name_enc
       FROM spot_cache_invites i
       JOIN user_spots u   ON u.id       = i.spot_id
       LEFT JOIN profiles pf ON pf.code  = i.from_code AND pf.spot = 'caching'
       LEFT JOIN profiles pt ON pt.code  = i.to_code   AND pt.spot = 'caching'
       WHERE i.from_code = $1 OR i.to_code = $1
       ORDER BY i.created_at DESC`,
      [code],
    );

    // Namen entschlüsseln bevor sie ans Frontend gehen –
    // decrypt() gibt null zurück wenn der Wert null/undefined ist, also sicher.
    res.json(
      rows.map((row) => ({
        ...row,
        from_name: row.from_name_enc ? decrypt(row.from_name_enc) : null,
        to_name: row.to_name_enc ? decrypt(row.to_name_enc) : null,
        // Rohdaten entfernen damit keine verschlüsselten Werte ans Frontend gelangen
        from_name_enc: undefined,
        to_name_enc: undefined,
      })),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Einladung annehmen oder ablehnen
app.patch("/api/spotcache/invite/:id", async (req, res) => {
  const { id } = req.params;
  const { status, code } = req.body;

  if (!["accepted", "declined"].includes(status)) {
    return res.status(400).json({ error: "Ungültiger Status" });
  }

  try {
    const result = await pool.query(
      // Nur der Empfänger (to_code) darf antworten – Sicherheits-Check
      `UPDATE spot_cache_invites SET status = $1
       WHERE id = $2 AND to_code = $3
       RETURNING *`,
      [status, id, code],
    );
    if (result.rowCount === 0) {
      return res.status(403).json({ error: "Nicht berechtigt" });
    }

    if (status === "accepted") {
      const invite = result.rows[0];
      const room = [invite.from_code, invite.to_code].sort().join("-");
      if (!invites[invite.from_code]) invites[invite.from_code] = [];
      invites[invite.from_code].push({
        // ← hier öffnet ein Objekt
        from: invite.to_code,
        to: invite.from_code,
        ts: Date.now(),
        room,
      }); // ← Objekt geschlossen
    } // ← if-Block geschlossen
    res.json({ ok: true, invite: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN – Avatar Moderation
// ══════════════════════════════════════════════════════════════════════════════

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Kein Zugriff" });
  }
  next();
}

app.get("/api/admin/pending-avatars", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT code, spot, avatar, avatar_status, updated_at
       FROM profiles
       WHERE avatar IS NOT NULL AND avatar_status = 'pending'
       ORDER BY updated_at ASC`,
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.post("/api/admin/avatar-action", requireAdmin, async (req, res) => {
  const { code, spot, action } = req.body;
  if (!code || !spot || !["approve", "reject"].includes(action)) {
    return res
      .status(400)
      .json({ error: "code, spot und action (approve/reject) erforderlich" });
  }
  try {
    if (action === "approve") {
      await pool.query(
        "UPDATE profiles SET avatar_status = $1 WHERE code = $2 AND spot = $3",
        ["approved", code, spot],
      );
      console.log(`✅ Avatar freigegeben: ${code} (${spot})`);
    } else {
      await pool.query(
        "UPDATE profiles SET avatar = NULL, avatar_status = NULL WHERE code = $1 AND spot = $2",
        [code, spot],
      );
      console.log(`❌ Avatar abgelehnt & gelöscht: ${code} (${spot})`);
    }
    res.json({ success: true, action, code, spot });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// WOCHEN‑SPOTS (anonyme 7‑Tage‑Spots für spot-woche.html)
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/weekly-spots", async (req, res) => {
  const { code, token, name, category, description, lat, lng, meetingAt } =
    req.body;
  if (!code || !token || !name || lat == null || lng == null) {
    return res
      .status(400)
      .json({ error: "code, token, name, lat, lng erforderlich" });
  }
  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2 AND token IS NOT NULL",
      [code, "caching"],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    const tokenId = crypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Hier die Änderung: meetingAt ist bereits ISO-String, keine Umwandlung in Millisekunden
    const meetingTimestamp = meetingAt ? meetingAt : null;
    await pool.query(
      `INSERT INTO weekly_spots (token, code, name, category, description, lat, lng, meeting_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tokenId,
        code,
        name,
        category || null,
        description || null,
        lat,
        lng,
        meetingTimestamp,
        expiresAt,
        now,
      ],
    );
    res.json({ success: true, spot: { token: tokenId, name } });
  } catch (e) {
    console.error("POST /api/weekly-spots:", e.message);
    res.status(500).json({ error: "Fehler beim Erstellen" });
  }
});

app.get("/api/weekly-spots/mine", async (req, res) => {
  const { code, token } = req.query;
  if (!code || !token)
    return res.status(400).json({ error: "code und token erforderlich" });
  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2 AND token IS NOT NULL",
      [code, "caching"],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    const now = Date.now();
    const { rows } = await pool.query(
      `SELECT token, name, category, description, lat, lng, meeting_at, expires_at, checkin_count
       FROM weekly_spots WHERE code = $1 AND expires_at > $2 ORDER BY created_at DESC`,
      [code, now],
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /api/weekly-spots/mine:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.delete("/api/weekly-spots/:token", async (req, res) => {
  const { token } = req.params;
  const { code, token: authToken } = req.body;
  if (!code || !authToken)
    return res.status(400).json({ error: "code und token erforderlich" });
  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND spot = $2 AND token IS NOT NULL",
      [code, "caching"],
    );
    if (!auth.rows.length || auth.rows[0].token !== authToken) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    const result = await pool.query(
      "DELETE FROM weekly_spots WHERE token = $1 AND code = $2",
      [token, code],
    );
    if (result.rowCount === 0)
      return res
        .status(404)
        .json({ error: "Nicht gefunden oder nicht berechtigt" });
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/weekly-spots/:token:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/weekly-spots/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT token, name, category, description, lat, lng, meeting_at, expires_at, checkin_count
       FROM weekly_spots WHERE token = $1 AND expires_at > $2`,
      [token, Date.now()],
    );
    if (!rows.length)
      return res
        .status(404)
        .json({ error: "Spot nicht gefunden oder abgelaufen" });
    res.json(rows[0]);
  } catch (e) {
    console.error("GET /api/weekly-spots/:token:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.post("/api/weekly-spots/:token/checkin", async (req, res) => {
  const { token } = req.params;
  try {
    const result = await pool.query(
      `UPDATE weekly_spots SET checkin_count = checkin_count + 1
       WHERE token = $1 AND expires_at > $2
       RETURNING checkin_count, name, code`,
      [token, Date.now()],
    );
    if (result.rowCount === 0)
      return res
        .status(404)
        .json({ error: "Spot nicht gefunden oder abgelaufen" });

    const { checkin_count, name, code } = result.rows[0];
    // Push an Wochen-Spot Ersteller (fire-and-forget)
    sendPushToCode(
      code,
      "🗓️ Neuer Check-in",
      `Jemand hat deinen Wochen-Spot „${name}" besucht`,
      `/spot-woche.html?token=${token}`,
    );

    res.json({ success: true, label: "anonym", count: checkin_count });
  } catch (e) {
    console.error("POST /api/weekly-spots/:token/checkin:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SPOTCACHE – GEHEIME TREFFPUNKTE
// ══════════════════════════════════════════════════════════════════════════════

// 1️⃣ Matching: gemeinsame Wünsche + nahe Profile
app.get("/api/spotcache/match/:code", async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || "gay";
  const now = Date.now();

  try {
    const myProfile = await pool.query(
      "SELECT wish_tags, offer_tags, region FROM profiles WHERE code = $1 AND spot = $2 AND visible_until > $3",
      [code, spot, now],
    );
    if (!myProfile.rows.length) return res.json({ matches: [] });
    const my = myProfile.rows[0];
    const myWishes = my.wish_tags ? JSON.parse(decrypt(my.wish_tags)) : [];

    const candidates = await pool.query(
      `
      SELECT p.code, p.name, p.city, p.region,
             p.wish_tags, p.offer_tags,
             l.lat, l.lng
      FROM profiles p
      LEFT JOIN LATERAL (
        SELECT data->>'lat' AS lat, data->>'lng' AS lng
        FROM (
          SELECT value::jsonb AS data
          FROM jsonb_each((SELECT jsonb_object_agg(key, value) FROM (SELECT * FROM location_cache) t))
        ) sub
        WHERE key = p.code || ':' || $2
        LIMIT 1
      ) l ON true
      WHERE p.code <> $1 AND p.spot = $2 AND p.visible_until > $3
    `,
      [code, spot, now],
    );

    const matches = candidates.rows
      .filter((c) => {
        const theirWishes = c.wish_tags ? JSON.parse(decrypt(c.wish_tags)) : [];
        return theirWishes.some((w) => myWishes.includes(w));
      })
      .map((c) => {
        const theirWishes = c.wish_tags ? JSON.parse(decrypt(c.wish_tags)) : [];
        const common = myWishes.filter((w) => theirWishes.includes(w));
        return {
          code: c.code,
          name: decrypt(c.name),
          city: c.city,
          region: c.region,
          commonWishes: common,
          lat: c.lat ? parseFloat(c.lat) : null,
          lng: c.lng ? parseFloat(c.lng) : null,
        };
      });
    res.json({ matches });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Matching fehlgeschlagen" });
  }
});

// 2️⃣ Cache-Anfrage senden
app.post("/api/spotcache/request", async (req, res) => {
  const { from, to, wish } = req.body;
  if (!from || !to || !wish)
    return res.status(400).json({ error: "Fehlende Felder" });

  try {
    const existing = await pool.query(
      `SELECT id FROM spot_cache_requests
       WHERE from_code = $1 AND to_code = $2 AND wish = $3 AND status IN ('pending','accepted')`,
      [from, to, wish],
    );
    if (existing.rows.length)
      return res.status(409).json({ error: "Bereits angefragt" });

    await pool.query(
      `INSERT INTO spot_cache_requests (from_code, to_code, wish, status, created_at)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [from, to, wish, Date.now()],
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Erstellen" });
  }
});

// 3️⃣ Eigene Anfragen anzeigen
app.get("/api/spotcache/requests/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, from_code AS "from", to_code AS "to", wish, status,
              location_lat AS lat, location_lng AS lng, unlocked_at
       FROM spot_cache_requests
       WHERE (from_code = $1 OR to_code = $1) AND status != 'declined'
       ORDER BY created_at DESC`,
      [code],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Abrufen" });
  }
});

// 4️⃣ Auf Anfrage antworten
app.post("/api/spotcache/respond", async (req, res) => {
  const { id, code, action } = req.body; // action: 'accept' | 'decline'
  if (!id || !code || !["accept", "decline"].includes(action)) {
    return res.status(400).json({ error: "Ungültige Parameter" });
  }

  try {
    const request = await pool.query(
      `SELECT * FROM spot_cache_requests WHERE id = $1`,
      [id],
    );
    if (!request.rows.length)
      return res.status(404).json({ error: "Nicht gefunden" });

    const reqData = request.rows[0];
    if (reqData.to_code !== code && reqData.from_code !== code) {
      return res.status(403).json({ error: "Keine Berechtigung" });
    }

    if (action === "decline") {
      await pool.query(
        `UPDATE spot_cache_requests SET status = 'declined' WHERE id = $1`,
        [id],
      );
      return res.json({ success: true, status: "declined" });
    }

    // Empfänger akzeptiert
    if (reqData.status === "pending" && reqData.to_code === code) {
      await pool.query(
        `UPDATE spot_cache_requests SET status = 'accepted' WHERE id = $1`,
        [id],
      );

      // Gegenseitige Anfrage prüfen
      const reciprocal = await pool.query(
        `SELECT id FROM spot_cache_requests
         WHERE from_code = $1 AND to_code = $2 AND wish = $3 AND status = 'accepted'`,
        [reqData.to_code, reqData.from_code, reqData.wish],
      );
      if (reciprocal.rows.length) {
        await unlockCache(reqData, reciprocal.rows[0].id);
      }
      return res.json({ success: true, status: "accepted" });
    }

    res.status(400).json({ error: "Ungültiger Zustand" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler" });
  }
});

// Hilfsfunktion: Treffpunkt generieren und beide Requests updaten
async function unlockCache(reqA, reqBId) {
  const latA = reqA.location_lat || 39.47;
  const lngA = reqA.location_lng || -0.38;
  const requestB = await pool.query(
    `SELECT location_lat, location_lng FROM spot_cache_requests WHERE id = $1`,
    [reqBId],
  );
  const latB = requestB.rows[0]?.location_lat || 39.47;
  const lngB = requestB.rows[0]?.location_lng || -0.38;

  const midLat = (latA + latB) / 2;
  const midLng = (lngA + lngB) / 2;
  const offset = 0.01; // ~1 km
  const targetLat = midLat + (Math.random() - 0.5) * offset * 2;
  const targetLng = midLng + (Math.random() - 0.5) * offset * 2;

  const now = Date.now();
  await pool.query(
    `UPDATE spot_cache_requests SET status = 'unlocked', location_lat = $1, location_lng = $2, unlocked_at = $3
     WHERE id IN ($4, $5)`,
    [targetLat, targetLng, now, reqA.id, reqBId],
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SPOTCACHE V2 – USER SPOTS & EINLADUNGEN
// ══════════════════════════════════════════════════════════════════════════════

// 🟠 Eigenen Spot anlegen
app.post("/api/userspots", async (req, res) => {
  const {
    code,
    lat,
    lng,
    name,
    description,
    wishTag,
    image,
    area_type,
    time_pref,
    crowd_level,
    intimacy_level,
  } = req.body;
  if (!code || lat == null || lng == null || !name || !wishTag) {
    return res
      .status(400)
      .json({ error: "Pflichtfelder: code, lat, lng, name, wishTag" });
  }
  try {
    await pool.query(
      // active=true ist der Standard – jeder neue Spot ist sofort sichtbar
      // Die neuen Felder area_type, time_pref, crowd_level, intimacy_level
      // sind optional – ältere Spots ohne diese Felder funktionieren weiterhin.
      `INSERT INTO user_spots
         (code, lat, lng, name, description, wish_tag, image, active,
          area_type, time_pref, crowd_level, intimacy_level, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11, $12)`,
      [
        code,
        lat,
        lng,
        name,
        description || null,
        wishTag,
        image || null,
        area_type || null,
        time_pref || null,
        crowd_level || null,
        intimacy_level || null,
        Date.now(),
      ],
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Speichern" });
  }
});

// 🌍 Alle öffentlichen Spots abrufen (für die Karte)
// Nur aktive Spots werden geliefert – deaktivierte Spots sind unsichtbar
app.get("/api/userspots/all", async (req, res) => {
  const noImage = req.query.noimage === "1";
  try {
    const { rows } = await pool.query(
      `SELECT id, code, lat, lng, name, description, wish_tag AS "wishTag",
              ${noImage ? "NULL AS image" : "CASE WHEN image_status = 'approved' THEN image ELSE NULL END AS image"},
              active, area_type, time_pref, crowd_level, intimacy_level, created_at
       FROM user_spots
       WHERE active = true
       ORDER BY created_at DESC`,
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Abrufen" });
  }
});

// 🟠 Eigene Spots abrufen
// Der Eigentümer bekommt immer sein Bild zurück – unabhängig vom image_status.
// Das ist wichtig damit das Frontend beim Bearbeiten nicht null mitschickt
// und damit das Bild einer approved-Spot-Bearbeitung nicht verloren geht.
// image_status wird mitgeliefert damit das Frontend einen passenden Hinweis
// anzeigen kann: "⏳ Bild wird moderiert" vs. "✅ Bild freigegeben"
app.get("/api/userspots/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, lat, lng, name, description, wish_tag AS "wishTag",
              image,           -- immer zurückgeben, nicht nach Status filtern
              image_status,    -- Frontend kann den Status selbst anzeigen
              active,
              area_type, time_pref, crowd_level, intimacy_level,
              created_at
       FROM user_spots
       WHERE code = $1
       ORDER BY created_at DESC`,
      [code],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Abrufen" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ÖFFENTLICHE CHECK-INS – Favoriten-Spots ohne Einladungspflicht
// Nur Nutzer mit aktivem Profil können öffentliche Check-ins ankündigen.
// Die 4-Stunden-Regel wird serverseitig geprüft – das Frontend könnte
// manipuliert werden, der Server nicht.
// ══════════════════════════════════════════════════════════════════════════════

// 📍 Öffentlichen Check-in ankündigen
app.post("/api/checkins/public", async (req, res) => {
  const { code, spot_id, checkin_at, note } = req.body;

  if (!code || !spot_id || !checkin_at) {
    return res
      .status(400)
      .json({ error: "code, spot_id und checkin_at sind Pflicht" });
  }

  // 4-Stunden-Regel: Check-in muss in der Zukunft liegen
  const fourHoursFromNow = Date.now() + 4 * 60 * 60 * 1000;
  if (checkin_at < fourHoursFromNow) {
    return res.status(400).json({
      error: "Check-in muss mindestens 4 Stunden in der Zukunft liegen",
    });
  }

  try {
    // Aktives Profil prüfen – nur wer ein Profil hat darf einchecken
    const profile = await pool.query(
      `SELECT name FROM profiles WHERE code = $1 AND spot = 'caching'`,
      [code],
    );
    if (!profile.rows.length) {
      return res.status(403).json({ error: "Kein aktives Profil gefunden" });
    }

    // Spot muss als Favorit gespeichert sein
    const fav = await pool.query(
      `SELECT 1 FROM spot_favorites WHERE code = $1 AND spot_id = $2`,
      [code, spot_id],
    );
    if (!fav.rows.length) {
      return res
        .status(403)
        .json({ error: "Spot ist nicht in deinen Favoriten" });
    }

    // Check-in ankündigen
    const result = await pool.query(
      `INSERT INTO spot_checkins_public (spot_id, code, checkin_at, note, status, created_at)
       VALUES ($1, $2, $3, $4, 'planned', $5)
       RETURNING id`,
      [spot_id, code, checkin_at, note || null, Date.now()],
    );

    // Alle anderen Favoriten dieses Spots benachrichtigen
    const spotData = await pool.query(
      `SELECT name FROM user_spots WHERE id = $1`,
      [spot_id],
    );
    const spotName = spotData.rows[0]?.name || "Spot";
    const profileName = decrypt(profile.rows[0].name) || code;
    const timeStr = new Date(checkin_at).toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const otherFavs = await pool.query(
      `SELECT code FROM spot_favorites WHERE spot_id = $1 AND code != $2`,
      [spot_id, code],
    );
    for (const fav of otherFavs.rows) {
      await pool.query(
        `INSERT INTO offline_messages
           (recipient, sender_code, sender_name, message, spot_type)
         VALUES ($1, $2, $3, $4, 'public_checkin')`,
        [
          fav.code,
          code,
          profileName,
          `📍 ${profileName} ist am ${timeStr} bei "${spotName}"`,
        ],
      );
    }

    console.log(
      `📍 Öffentlicher Check-in: ${code} @ Spot ${spot_id} um ${timeStr}`,
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (e) {
    console.error("POST /api/checkins/public:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// 📍 Öffentliche Check-ins für einen Spot abrufen
// Zeigt alle geplanten Check-ins aller Favoriten – mit Profilnamen.
// Nur aktive (noch nicht abgelaufene) Check-ins werden angezeigt.
app.get("/api/checkins/public/:spotId", async (req, res) => {
  const { spotId } = req.params;
  const now = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.code, c.checkin_at, c.note, c.status,
              p.name AS profile_name_enc
       FROM spot_checkins_public c
       LEFT JOIN profiles p ON p.code = c.code AND p.spot = 'caching'
       WHERE c.spot_id = $1
         AND c.checkin_at > $2
         AND c.status = 'planned'
       ORDER BY c.checkin_at ASC`,
      [spotId, now],
    );
    res.json(
      rows.map((r) => ({
        ...r,
        profile_name: r.profile_name_enc ? decrypt(r.profile_name_enc) : null,
        profile_name_enc: undefined,
      })),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 📍 Eigenen öffentlichen Check-in stornieren
app.delete("/api/checkins/public/:id", async (req, res) => {
  const { id } = req.params;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code erforderlich" });
  try {
    await pool.query(
      `UPDATE spot_checkins_public SET status = 'cancelled'
       WHERE id = $1 AND code = $2`,
      [id, code],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🟠 Spot bearbeiten
app.put("/api/userspots/:id", async (req, res) => {
  const { id } = req.params;
  const { code, name, description, wishTag, image, area_type } = req.body;
  if (!code || !name || !wishTag) {
    return res.status(400).json({ error: "code, name, wishTag erforderlich" });
  }
  try {
    // Eigentümer prüfen
    const check = await pool.query(
      "SELECT code FROM user_spots WHERE id = $1",
      [id],
    );
    if (!check.rows.length)
      return res.status(404).json({ error: "Nicht gefunden" });
    if (check.rows[0].code !== code)
      return res.status(403).json({ error: "Keine Berechtigung" });

    if (image) {
      // Neues Bild mitgeschickt → speichern und auf 'pending' setzen
      // Das neue Bild muss vom Admin erneut freigegeben werden
      await pool.query(
        `UPDATE user_spots
         SET name=$1, description=$2, wish_tag=$3, image=$4, image_status='pending', area_type=$5
         WHERE id=$6`,
        [name, description || null, wishTag, image, area_type || null, id],
      );
    } else {
      // Kein neues Bild → name/description/wishTag/area_type aktualisieren,
      // aber image und image_status NICHT anfassen.
      // Das ist der Schutz vor dem "versehentlichen Löschen" –
      // wenn das Frontend beim Bearbeiten image=null schickt weil es
      // das pending-Bild nicht kennt, bleibt das Bild trotzdem erhalten.
      await pool.query(
        `UPDATE user_spots
         SET name=$1, description=$2, wish_tag=$3, area_type=$4
         WHERE id=$5`,
        [name, description || null, wishTag, area_type || null, id],
      );
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Aktualisieren" });
  }
});

app.delete("/api/userspots/:id", async (req, res) => {
  const { id } = req.params;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code fehlt" });
  try {
    await pool.query("DELETE FROM user_spots WHERE id = $1 AND code = $2", [
      id,
      code,
    ]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Löschen" });
  }
});

// ⏸ Spot deaktivieren / reaktivieren (Soft Delete)
// PATCH statt DELETE – wir ändern nur den active-Status, löschen nichts.
// Der Spot bleibt in der Datenbank erhalten und kann jederzeit reaktiviert werden.
// Auf der Karte und in der Spot-Liste erscheint er solange active=false ist nicht mehr.
app.patch("/api/userspots/:id/toggle", async (req, res) => {
  const { id } = req.params;
  const { code, token } = req.body;

  if (!code || !token) {
    return res.status(400).json({ error: "Code und Token erforderlich" });
  }

  try {
    // Sicherheits-Check 1: Gehört dieser Spot wirklich diesem Nutzer?
    // Wir prüfen gleichzeitig ob der Spot überhaupt existiert.
    const check = await pool.query(
      `SELECT active FROM user_spots WHERE id = $1 AND code = $2`,
      [id, code],
    );
    if (!check.rows.length) {
      return res
        .status(403)
        .json({ error: "Nicht berechtigt oder Spot nicht gefunden" });
    }

    // Sicherheits-Check 2: Ist das Token gültig?
    // Ein gestohlener Code allein reicht nicht aus – das Token muss stimmen.
    const auth = await pool.query(
      `SELECT token FROM profiles WHERE code = $1 AND spot = 'caching'`,
      [code],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }

    // Status umkehren: true → false, false → true
    // Das NOT in SQL funktioniert wie das ! in JavaScript
    const result = await pool.query(
      `UPDATE user_spots
       SET active = NOT active
       WHERE id = $1 AND code = $2
       RETURNING active`,
      [id, code],
    );

    const newStatus = result.rows[0].active;
    console.log(
      `🔄 Spot ${id} (${code}): ${newStatus ? "▶ aktiviert" : "⏸ deaktiviert"}`,
    );
    res.json({ success: true, active: newStatus });
  } catch (e) {
    console.error("PATCH /api/userspots/toggle:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// 🟣 Gemeinsame Spots finden (gleicher Wunsch + Nähe)
app.get("/api/userspots/common/:code1/:code2", async (req, res) => {
  const { code1, code2 } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT s1.id AS "spot1Id", s1.lat, s1.lng,
             s1.name AS "spotName", s1.description AS "spotDesc",
             s1.wish_tag AS "wishTag", s1.code AS "creatorCode"
      FROM user_spots s1
      JOIN user_spots s2 ON s1.wish_tag = s2.wish_tag
      WHERE s1.code = $1 AND s2.code = $2
        AND ABS(s1.lat - s2.lat) < 0.02
        AND ABS(s1.lng - s2.lng) < 0.02
      ORDER BY s1.created_at DESC
    `,
      [code1, code2],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler bei der Suche" });
  }
});

// 📨 Treffpunkt-Einladung senden
app.post("/api/spotcache/invite", async (req, res) => {
  const { from, to } = req.body;
  const spotId = req.body.spot_id || req.body.spotId;
  const timeStart = req.body.time_start || req.body.timeStart;
  const timeEnd = req.body.time_end || req.body.timeEnd;

  if (!from || !to || !spotId || !timeStart || !timeEnd) {
    return res.status(400).json({ error: "Fehlende Felder" });
  }

  try {
    // Schritt 1: Alte Einladungen für diesen Spot archivieren.
    // Wir prüfen BEIDE Richtungen (A→B und B→A) weil Einladungen
    // symmetrisch sind – es ist egal wer wen zuerst eingeladen hat.
    // Wir archivieren sowohl 'accepted' als auch 'pending' Einladungen,
    // damit der UNIQUE-Constraint für den INSERT frei wird.
    await pool.query(
      `UPDATE spot_cache_invites
       SET status = 'expired'
       WHERE spot_id = $1
         AND (
           (from_code = $2 AND to_code = $3) OR
           (from_code = $3 AND to_code = $2)
         )
         AND status IN ('accepted', 'pending')
         AND time_end < $4`,
      [spotId, from, to, Date.now()],
    );

    // Schritt 2: Neue Einladung einfügen.
    // ON CONFLICT als Sicherheitsnetz – falls doch noch ein Konflikt
    // entsteht (z.B. Race Condition), wird die bestehende Einladung
    // mit den neuen Zeitwerten aktualisiert statt einen Fehler zu werfen.
    await pool.query(
      `INSERT INTO spot_cache_invites
         (from_code, to_code, spot_id, time_start, time_end, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (from_code, to_code, spot_id)
       DO UPDATE SET
         time_start = EXCLUDED.time_start,
         time_end   = EXCLUDED.time_end,
         status     = 'pending',
         created_at = EXCLUDED.created_at`,
      [from, to, spotId, timeStart, timeEnd, Date.now()],
    );

    res.json({ success: true });
    // Push an Spot-Besitzer (fire-and-forget)
    sendPushToCode(
      to,
      "📨 Neue Einladung",
      "Jemand möchte deinen Spot besuchen – tippe zum Antworten",
      "/",
    );
  } catch (e) {
    console.error("POST /api/spotcache/invite:", e.message);
    res.status(500).json({ error: "Fehler beim Einladen" });
  }
});

// 📨 Einladung beantworten
app.post("/api/spotcache/invite/respond", async (req, res) => {
  const { id, code, action } = req.body;
  if (!id || !code || !["accept", "decline"].includes(action)) {
    return res.status(400).json({ error: "Ungültige Parameter" });
  }
  try {
    const invite = await pool.query(
      "SELECT * FROM spot_cache_invites WHERE id = $1",
      [id],
    );
    if (!invite.rows.length)
      return res.status(404).json({ error: "Nicht gefunden" });
    const inv = invite.rows[0];
    if (inv.to_code !== code)
      return res.status(403).json({ error: "Keine Berechtigung" });

    if (action === "decline") {
      await pool.query(
        `UPDATE spot_cache_invites SET status = 'declined' WHERE id = $1`,
        [id],
      );
      return res.json({ success: true, status: "declined" });
    }

    await pool.query(
      `UPDATE spot_cache_invites SET status = 'accepted' WHERE id = $1`,
      [id],
    );
    // Push an Einladungs-Sender (fire-and-forget)
    sendPushToCode(
      inv.from_code,
      "✅ Einladung angenommen",
      `${code} hat deine Einladung angenommen`,
      "/",
    );
    res.json({ success: true, status: "accepted" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler" });
  }
});

// ❌ Einladung stornieren
// Sowohl Sender (from_code) als auch Empfänger (to_code) dürfen stornieren.
// Der Partner bekommt automatisch eine System-Nachricht damit er informiert ist.
// Wir setzen status = 'cancelled' statt zu löschen – so bleibt die Historie erhalten.
app.patch("/api/spotcache/invite/:id/cancel", async (req, res) => {
  const { id } = req.params;
  const { code, token } = req.body;

  if (!code || !token) {
    return res.status(400).json({ error: "Code und Token erforderlich" });
  }

  try {
    // Einladung laden und prüfen ob der anfragende Nutzer beteiligt ist.
    // Sowohl Sender als auch Empfänger dürfen stornieren.
    const inv = await pool.query(
      `SELECT i.*, u.name AS spot_name
       FROM spot_cache_invites i
       LEFT JOIN user_spots u ON u.id = i.spot_id
       WHERE i.id = $1 AND (i.from_code = $2 OR i.to_code = $2)`,
      [id, code],
    );
    if (!inv.rows.length) {
      return res
        .status(403)
        .json({ error: "Nicht berechtigt oder nicht gefunden" });
    }

    // Token validieren – ein gestohlener Code allein reicht nicht
    const auth = await pool.query(
      `SELECT token FROM profiles WHERE code = $1 AND spot = 'caching'`,
      [code],
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }

    const invite = inv.rows[0];
    const spotName = invite.spot_name || "Spot";

    // Nur aktive Einladungen können storniert werden –
    // abgelaufene oder bereits abgelehnte brauchen keine Stornierung mehr
    if (
      ["expired", "cancelled", "declined", "completed"].includes(invite.status)
    ) {
      return res
        .status(400)
        .json({ error: "Diese Einladung kann nicht mehr storniert werden" });
    }

    // Status auf 'cancelled' setzen
    await pool.query(
      `UPDATE spot_cache_invites SET status = 'cancelled' WHERE id = $1`,
      [id],
    );

    // Partner bestimmen: wenn ich der Sender bin, ist der Partner der Empfänger und umgekehrt
    const partnerCode =
      invite.from_code === code ? invite.to_code : invite.from_code;

    // System-Nachricht an den Partner schicken damit er informiert wird.
    // spot_type = 'system' unterscheidet diese Nachricht von normalen Chat-Nachrichten –
    // das Frontend kann sie dann anders darstellen (z.B. grau und kursiv)
    await pool.query(
      `INSERT INTO offline_messages
         (recipient, sender_code, sender_name, message, spot_type)
       VALUES ($1, $2, $3, $4, 'system')`,
      [
        partnerCode,
        code,
        "System",
        `❌ Das Treffen bei "${spotName}" wurde storniert.`,
      ],
    );

    console.log(
      `❌ Einladung ${id} storniert von ${code} → Partner ${partnerCode} informiert`,
    );
    res.json({ success: true });
  } catch (e) {
    console.error("PATCH /cancel:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FAVORITEN – Öffentliche Spot-Kategorien ohne Einladungspflicht
// ══════════════════════════════════════════════════════════════════════════════

// ⭐ Favorit hinzufügen
app.post("/api/favorites", async (req, res) => {
  const { code, spot_id } = req.body;
  if (!code || !spot_id)
    return res.status(400).json({ error: "code und spot_id erforderlich" });
  try {
    await pool.query(
      `INSERT INTO spot_favorites (code, spot_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (code, spot_id) DO NOTHING`,
      [code, spot_id, Date.now()],
    );
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/favorites:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ⭐ Favorit entfernen
app.delete("/api/favorites/:spotId", async (req, res) => {
  const { spotId } = req.params;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code erforderlich" });
  try {
    await pool.query(
      `DELETE FROM spot_favorites WHERE code = $1 AND spot_id = $2`,
      [code, spotId],
    );
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/favorites:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ⭐ Alle Favoriten eines Nutzers abrufen – mit Spot-Details und letztem Check-in
app.get("/api/favorites/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT f.spot_id,
              u.name      AS spot_name,
              u.lat, u.lng,
              u.wish_tag  AS "wishTag",
              u.code      AS owner_code,
              -- Letzter Check-in an diesem Spot (aus verifications)
              v.created_at AS last_checkin,
              v.from_code  AS last_checkin_code,
              p.name       AS last_checkin_name_enc
       FROM spot_favorites f
       JOIN user_spots u ON u.id = f.spot_id
       -- Neuester Check-in pro Spot – LATERAL macht das effizient
       LEFT JOIN LATERAL (
         SELECT from_code, created_at
         FROM verifications
         WHERE to_code = u.code AND to_spot = 'caching' AND type = 'personal'
         ORDER BY created_at DESC
         LIMIT 1
       ) v ON true
       LEFT JOIN profiles p ON p.code = v.from_code AND p.spot = 'caching'
       WHERE f.code = $1
         AND u.active = true
       ORDER BY f.created_at DESC`,
      [code],
    );
    res.json(
      rows.map((r) => ({
        ...r,
        last_checkin_name: r.last_checkin_name_enc
          ? decrypt(r.last_checkin_name_enc)
          : null,
        last_checkin_name_enc: undefined,
      })),
    );
  } catch (e) {
    console.error("GET /api/favorites:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ⭐ Prüfen ob ein Spot bereits als Favorit gespeichert ist (für den ⭐-Button)
app.get("/api/favorites/:code/:spotId", async (req, res) => {
  const { code, spotId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM spot_favorites WHERE code = $1 AND spot_id = $2`,
      [code, spotId],
    );
    res.json({ isFavorite: rows.length > 0 });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// 📍 Einchecken am Treffpunkt
app.post("/api/spotcache/checkin", async (req, res) => {
  const { id, code, lat, lng } = req.body;
  if (!id || !code || lat == null || lng == null)
    return res.status(400).json({ error: "Fehlende Felder" });

  try {
    const invite = await pool.query(
      "SELECT * FROM spot_cache_invites WHERE id = $1",
      [id],
    );
    if (!invite.rows.length)
      return res.status(404).json({ error: "Nicht gefunden" });
    const inv = invite.rows[0];
    if (inv.from_code !== code && inv.to_code !== code)
      return res.status(403).json({ error: "Keine Berechtigung" });
    if (inv.status !== "accepted")
      return res.status(400).json({ error: "Noch nicht akzeptiert" });

    const now = Date.now();
    if (now < inv.time_start || now > inv.time_end)
      return res.status(400).json({ error: "Außerhalb des Zeitfensters" });

    // 50m‑Radius prüfen
    const spot = await pool.query(
      "SELECT lat, lng FROM user_spots WHERE id = $1",
      [inv.spot_id],
    );
    const dist =
      Math.sqrt(
        Math.pow(lat - spot.rows[0].lat, 2) +
          Math.pow(lng - spot.rows[0].lng, 2),
      ) * 111000;
    if (dist > 50)
      return res.status(400).json({ error: "Nicht nah genug am Spot (50m)" });

    const isFrom = inv.from_code === code;
    await pool.query(
      `UPDATE spot_cache_invites SET ${isFrom ? "checked_in_from" : "checked_in_to"} = TRUE WHERE id = $1`,
      [id],
    );

    const updated = await pool.query(
      "SELECT * FROM spot_cache_invites WHERE id = $1",
      [id],
    );
    const u = updated.rows[0];
    if (u.checked_in_from && u.checked_in_to) {
      await pool.query(
        `UPDATE spot_cache_invites SET status = 'completed' WHERE id = $1`,
        [id],
      );

      // ✅ Echtheits‑Verifikation
      const nowTS = Date.now();
      await pool.query(
        `INSERT INTO verifications (to_code, to_spot, from_code, type, created_at)
         VALUES ($1, 'caching', $2, 'personal', $3)
         ON CONFLICT (to_code, to_spot, from_code, type) DO NOTHING`,
        [inv.from_code, inv.to_code, nowTS],
      );
      await pool.query(
        `INSERT INTO verifications (to_code, to_spot, from_code, type, created_at)
         VALUES ($1, 'caching', $2, 'personal', $3)
         ON CONFLICT (to_code, to_spot, from_code, type) DO NOTHING`,
        [inv.to_code, inv.from_code, nowTS],
      );

      return res.json({
        success: true,
        bothCheckedIn: true,
        message: "Ihr habt euch gefunden!",
      });
    }

    // ⭐ Favoriten benachrichtigen wenn jemand an diesem Spot eincheckt.
    // Wir holen alle Nutzer die diesen Spot als Favorit gespeichert haben,
    // ausgenommen die beiden die gerade am Treffen beteiligt sind –
    // die wissen bereits dass jemand da ist.
    try {
      const spotData = await pool.query(
        `SELECT name FROM user_spots WHERE id = $1`,
        [inv.spot_id],
      );
      const spotName = spotData.rows[0]?.name || "Spot";

      const favorites = await pool.query(
        `SELECT code FROM spot_favorites
         WHERE spot_id = $1
           AND code != $2
           AND code != $3`,
        [inv.spot_id, inv.from_code, inv.to_code],
      );

      // Für jeden Favoriten eine stille Benachrichtigung schicken
      for (const fav of favorites.rows) {
        await pool.query(
          `INSERT INTO offline_messages
             (recipient, sender_code, sender_name, message, spot_type)
           VALUES ($1, $2, $3, $4, 'favorite_checkin')`,
          [
            fav.code,
            code,
            "SpotMe",
            `⭐ Jemand ist gerade bei "${spotName}" eingecheckt!`,
          ],
        );
      }
      if (favorites.rows.length > 0) {
        console.log(
          `⭐ ${favorites.rows.length} Favoriten über Check-in bei Spot ${inv.spot_id} benachrichtigt`,
        );
      }
    } catch (e) {
      // Benachrichtigungs-Fehler soll den Check-in nicht blockieren
      console.error("Favorites notify error:", e.message);
    }

    res.json({ success: true, bothCheckedIn: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Einchecken" });
  }
});

app.get("/api/admin/pending-spot-images", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, name, description, wish_tag, image, image_status, created_at
       FROM user_spots
       WHERE image IS NOT NULL AND (image_status = 'pending' OR image_status IS NULL)
       ORDER BY created_at ASC`,
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.post("/api/admin/spot-image-action", requireAdmin, async (req, res) => {
  const { id, action } = req.body;
  if (!id || !["approve", "reject"].includes(action)) {
    return res
      .status(400)
      .json({ error: "id und action (approve/reject) erforderlich" });
  }
  try {
    if (action === "approve") {
      await pool.query(
        `UPDATE user_spots SET image_status = 'approved' WHERE id = $1`,
        [id],
      );
      console.log(`✅ Spot-Bild freigegeben: ID ${id}`);
    } else {
      await pool.query(
        `UPDATE user_spots SET image = NULL, image_status = NULL WHERE id = $1`,
        [id],
      );
      console.log(`❌ Spot-Bild abgelehnt & gelöscht: ID ${id}`);
    }
    res.json({ success: true, action, id });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BLUESKY INTEGRATION
// App-Passwort wird mit demselben AES-256-CBC Schlüssel (CRYPTO_KEY)
// verschlüsselt wie alle anderen sensiblen Profildaten.
// Das entschlüsselte Passwort verlässt NIEMALS den Server.
// ══════════════════════════════════════════════════════════════════════════════

// Bluesky-Accounts Tabelle (falls noch nicht vorhanden)
// Wird von initDB() gehandhabt – hier zur Referenz:
// CREATE TABLE IF NOT EXISTS bluesky_accounts (
//   id           SERIAL PRIMARY KEY,
//   code         TEXT UNIQUE NOT NULL,
//   handle       TEXT NOT NULL,
//   app_password TEXT NOT NULL,   -- AES-256-CBC verschlüsselt
//   created_at   TIMESTAMPTZ DEFAULT NOW()
// );

// AT-Protocol Hilfsfunktion – erstellt eine Bluesky-Session
async function bskyCreateSession(handle, appPassword) {
  const res = await fetch(
    "https://bsky.social/xrpc/com.atproto.server.createSession",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: handle, password: appPassword }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Bluesky-Authentifizierung fehlgeschlagen");
  }
  return res.json();
}

// AT-Protocol Hilfsfunktion – postet einen Beitrag
async function bskyPost(accessJwt, did, text) {
  const res = await fetch(
    "https://bsky.social/xrpc/com.atproto.repo.createRecord",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessJwt}`,
      },
      body: JSON.stringify({
        repo: did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Bluesky-Post fehlgeschlagen");
  }
  return res.json();
}

// ── Verbindung herstellen ────────────────────────────────────────────────────
app.post("/api/bluesky/connect", async (req, res) => {
  const { code, token, handle, appPassword } = req.body;
  if (!code || !token || !handle || !appPassword)
    return res
      .status(400)
      .json({ error: "code, token, handle, appPassword erforderlich" });

  try {
    // Auth prüfen
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token))
      return res.status(403).json({ error: "Ungültiger Token" });

    // Bluesky-Credentials testen bevor wir speichern
    const session = await bskyCreateSession(handle, appPassword);

    // App-Passwort verschlüsselt speichern – nie im Klartext in der DB
    const encryptedPassword = encrypt(appPassword);

    await pool.query(
      `INSERT INTO bluesky_accounts (code, handle, app_password)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE
         SET handle = EXCLUDED.handle,
             app_password = EXCLUDED.app_password`,
      [code, handle.toLowerCase().replace(/^@/, ""), encryptedPassword],
    );

    console.log(`🦋 Bluesky verbunden: ${handle} für ${code}`);
    res.json({ success: true, handle: session.handle });
  } catch (e) {
    console.error("POST /api/bluesky/connect:", e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── Status abrufen (kein Passwort zurückgeben!) ──────────────────────────────
app.get("/api/bluesky/status/:code", async (req, res) => {
  const { token } = req.query;
  const { code } = req.params;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token))
      return res.status(403).json({ error: "Ungültiger Token" });

    const { rows } = await pool.query(
      "SELECT handle FROM bluesky_accounts WHERE code = $1",
      [code],
    );

    if (!rows.length) return res.json({ connected: false });
    // Nur Handle zurückgeben – niemals app_password
    res.json({ connected: true, handle: rows[0].handle });
  } catch (e) {
    console.error("GET /api/bluesky/status:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Spot auf Bluesky teilen ──────────────────────────────────────────────────
app.post("/api/bluesky/share-spot", async (req, res) => {
  const { code, token, spotId, message } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token))
      return res.status(403).json({ error: "Ungültiger Token" });

    // Bluesky-Konto + verschlüsseltes Passwort holen
    const { rows } = await pool.query(
      "SELECT handle, app_password FROM bluesky_accounts WHERE code = $1",
      [code],
    );
    if (!rows.length)
      return res.status(404).json({ error: "Kein Bluesky-Konto verknüpft" });

    // Passwort serverseitig entschlüsseln – verlässt diesen Scope nicht
    const appPassword = decrypt(rows[0].app_password);
    const session = await bskyCreateSession(rows[0].handle, appPassword);

    // Nachrichtentext (vom Client oder Standard-Fallback)
    const postText =
      message?.slice(0, 300) ||
      `📍 Ich habe einen neuen Spot auf SpotMe Caching entdeckt! #SpotMe #Caching`;

    const result = await bskyPost(session.accessJwt, session.did, postText);

    console.log(`🦋 Bluesky-Post: ${rows[0].handle} → ${result.uri}`);
    res.json({ success: true, uri: result.uri });
  } catch (e) {
    console.error("POST /api/bluesky/share-spot:", e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── Verbindung trennen ───────────────────────────────────────────────────────
app.delete("/api/bluesky/disconnect", async (req, res) => {
  const { code, token } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token))
      return res.status(403).json({ error: "Ungültiger Token" });

    await pool.query("DELETE FROM bluesky_accounts WHERE code = $1", [code]);
    console.log(`🔌 Bluesky getrennt: ${code}`);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/bluesky/disconnect:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});
// ══════════════════════════════════════════════════════════════════════════════

// Helper – sendet Push an alle Geräte eines Nutzers.
// Fire-and-forget (kein await nötig), blockiert den Request-Handler nicht.
// Abgelaufene Subscriptions (410/404) werden automatisch aus der DB gelöscht.
async function sendPushToCode(code, title, body, url = "/") {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM push_subscriptions WHERE code = $1",
      [code],
    );
    if (!rows.length) return;
    const payload = JSON.stringify({
      title,
      body,
      url,
      tag: `spotme-${Date.now()}`,
    });
    for (const sub of rows) {
      webpush
        .sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        )
        .catch(async (err) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await pool
              .query("DELETE FROM push_subscriptions WHERE endpoint = $1", [
                sub.endpoint,
              ])
              .catch(() => {});
          }
        });
    }
  } catch (e) {
    console.error("sendPushToCode:", e.message);
  }
}

// Öffentlichen VAPID-Key ans Frontend liefern
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// Push-Subscription speichern
app.post("/api/push/subscribe", async (req, res) => {
  const { code, token, subscription } = req.body;
  if (!code || !token || !subscription?.endpoint) {
    return res
      .status(400)
      .json({ error: "code, token, subscription erforderlich" });
  }
  try {
    const authRes = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    if (!authRes.rows.length || !authRes.rows.some((r) => r.token === token)) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (code, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code, endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [
        code,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
      ],
    );
    console.log(`🔔 Push registriert: ${code}`);
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/push/subscribe:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// Push-Subscription löschen
app.delete("/api/push/unsubscribe", async (req, res) => {
  const { code, token, endpoint } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    const authRes = await pool.query(
      "SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL",
      [code],
    );
    if (!authRes.rows.length || !authRes.rows.some((r) => r.token === token)) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    if (endpoint) {
      await pool.query(
        "DELETE FROM push_subscriptions WHERE code=$1 AND endpoint=$2",
        [code, endpoint],
      );
    } else {
      await pool.query("DELETE FROM push_subscriptions WHERE code=$1", [code]);
    }
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/push/unsubscribe:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// WAYPOINT CACHING
// Öffentliche Geocaching-Routen mit Wissensfragen an jedem WayPoint.
// Sicherheitsprinzip: Koordinaten von WayPoint N+1 werden NIEMALS an den
// Client gesendet bevor WayPoint N serverseitig korrekt beantwortet wurde.
// ══════════════════════════════════════════════════════════════════════════════

// ── Alle öffentlichen Routen ─────────────────────────────────────────────────
app.get("/api/wp/routes", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.code, r.name, r.description, r.difficulty,
             r.play_count, r.created_at,
             COUNT(w.id)::int          AS waypoint_count,
             MIN(c.time_seconds)       AS best_time,
             COUNT(DISTINCT c.player_code)::int AS completion_count
      FROM wp_routes r
      LEFT JOIN wp_waypoints   w ON w.route_id = r.id
      LEFT JOIN wp_completions c ON c.route_id = r.id
      WHERE r.published = true
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/wp/routes:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Route starten: gibt Metadaten + ersten WayPoint ──────────────────────────
app.post("/api/wp/routes/:id/start", async (req, res) => {
  const { player_code } = req.body;
  const routeId = +req.params.id;
  if (!player_code)
    return res.status(400).json({ error: "player_code erforderlich" });

  try {
    // Route existiert und ist veröffentlicht?
    const route = await pool.query(
      "SELECT * FROM wp_routes WHERE id=$1 AND published=true",
      [routeId],
    );
    if (!route.rows.length)
      return res.status(404).json({ error: "Route nicht gefunden" });

    // Bereits abgeschlossen?
    const done = await pool.query(
      "SELECT time_seconds FROM wp_completions WHERE route_id=$1 AND player_code=$2",
      [routeId, player_code],
    );
    if (done.rows.length) {
      return res.json({
        alreadyCompleted: true,
        time_seconds: done.rows[0].time_seconds,
      });
    }

    // Fortschritt abrufen oder neu anlegen
    const now = Date.now();
    await pool.query(
      `
      INSERT INTO wp_progress (route_id, player_code, current_index, started_at, last_activity_at)
      VALUES ($1,$2,0,$3,$3)
      ON CONFLICT (route_id, player_code) DO UPDATE SET last_activity_at=$3
    `,
      [routeId, player_code, now],
    );

    const prog = await pool.query(
      "SELECT * FROM wp_progress WHERE route_id=$1 AND player_code=$2",
      [routeId, player_code],
    );

    // Ersten noch offenen WayPoint liefern
    const wp = await pool.query(
      `SELECT id, order_index, lat, lng, question, question_type, option_a, option_b, option_c
       FROM wp_waypoints WHERE route_id=\$1 AND order_index=\$2`,
      [routeId, prog.rows[0].current_index],
    );
    if (!wp.rows.length)
      return res.status(404).json({ error: "Kein WayPoint gefunden" });

    // play_count nur beim echten ersten Start erhöhen
    if (prog.rows[0].current_index === 0 && prog.rows[0].started_at === now) {
      await pool.query(
        "UPDATE wp_routes SET play_count=play_count+1 WHERE id=$1",
        [routeId],
      );
    }

    const total = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM wp_waypoints WHERE route_id=$1",
      [routeId],
    );

    res.json({
      route: route.rows[0],
      waypoint: wp.rows[0],
      current_index: prog.rows[0].current_index,
      total: total.rows[0].cnt,
      started_at: prog.rows[0].started_at,
    });
  } catch (e) {
    console.error("POST /api/wp/routes/:id/start:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/coins/:code", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT coins FROM profiles WHERE code=\$1 LIMIT 1",
      [req.params.code],
    );
    res.json({ coins: rows[0]?.coins || 0 });
  } catch (e) {
    console.error("GET /api/coins/:code:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Antwort einreichen → gibt nächsten WayPoint oder Completion zurück ────────

app.post("/api/wp/routes/:id/answer", async (req, res) => {
  const { player_code, waypoint_index, answer } = req.body;
  const routeId = +req.params.id;
  if (
    !player_code ||
    waypoint_index == null ||
    answer == null ||
    answer === ""
  ) {
    return res
      .status(400)
      .json({ error: "player_code, waypoint_index, answer erforderlich" });
  }

  try {
    const prog = await pool.query(
      "SELECT * FROM wp_progress WHERE route_id=\$1 AND player_code=\$2",
      [routeId, player_code],
    );
    if (!prog.rows.length)
      return res.status(403).json({ error: "Route nicht gestartet" });
    if (prog.rows[0].current_index !== +waypoint_index) {
      return res.status(409).json({ error: "Falscher WayPoint-Index" });
    }

    const wp = await pool.query(
      "SELECT * FROM wp_waypoints WHERE route_id=\$1 AND order_index=\$2",
      [routeId, +waypoint_index],
    );
    if (!wp.rows.length)
      return res.status(404).json({ error: "WayPoint nicht gefunden" });

    const waypoint = wp.rows[0];
    let isCorrect;
    if (waypoint.question_type === "freitext") {
      isCorrect =
        answer.trim().toLowerCase() ===
        (waypoint.correct_text || "").trim().toLowerCase();
    } else {
      isCorrect = answer.toLowerCase() === waypoint.correct_option;
    }

    if (!isCorrect) {
      return res.json({ correct: false });
    }

    const routeRow = await pool.query(
      "SELECT difficulty FROM wp_routes WHERE id=\$1",
      [routeId],
    );
    const difficulty = routeRow.rows[0]?.difficulty || 1;

    const wpCoins = difficulty * 10;
    await pool.query(
      "UPDATE profiles SET coins = coins + \$1 WHERE code = \$2",
      [wpCoins, player_code],
    );
    await pool.query(
      "INSERT INTO coin_transactions (code, amount, reason, route_id) VALUES (\$1,\$2,\$3,\$4)",
      [player_code, wpCoins, "waypoint_solved", routeId],
    );

    const nextIndex = +waypoint_index + 1;
    const total = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM wp_waypoints WHERE route_id=\$1",
      [routeId],
    );
    const isLast = nextIndex >= total.rows[0].cnt;

    if (isLast) {
      const timeSec = Math.round((Date.now() - prog.rows[0].started_at) / 1000);
      await pool.query(
        `INSERT INTO wp_completions (route_id, player_code, time_seconds)
         VALUES (\$1,\$2,\$3)
         ON CONFLICT (route_id, player_code) DO UPDATE SET
           time_seconds = LEAST(EXCLUDED.time_seconds, wp_completions.time_seconds),
           completed_at = NOW()`,
        [routeId, player_code, timeSec],
      );
      await pool.query(
        "DELETE FROM wp_progress WHERE route_id=\$1 AND player_code=\$2",
        [routeId, player_code],
      );

      const bonusCoins = difficulty * 50;
      await pool.query(
        "UPDATE profiles SET coins = coins + \$1 WHERE code = \$2",
        [bonusCoins, player_code],
      );
      await pool.query(
        "INSERT INTO coin_transactions (code, amount, reason, route_id) VALUES (\$1,\$2,\$3,\$4)",
        [player_code, bonusCoins, "route_completed", routeId],
      );

      const rank = await pool.query(
        `SELECT COUNT(*)::int + 1 AS rank FROM wp_completions
         WHERE route_id=\$1 AND time_seconds < \$2`,
        [routeId, timeSec],
      );

      console.log(
        `🏆 WayPoint abgeschlossen: \${player_code} Route \${routeId} in \${timeSec}s (+\${wpCoins + bonusCoins} Coins)`,
      );
      return res.json({
        correct: true,
        completed: true,
        time_seconds: timeSec,
        rank: rank.rows[0].rank,
        coins_earned: wpCoins + bonusCoins,
      });
    }

    await pool.query(
      `UPDATE wp_progress SET current_index=\$1, last_activity_at=\$2
       WHERE route_id=\$3 AND player_code=\$4`,
      [nextIndex, Date.now(), routeId, player_code],
    );
    const nextWp = await pool.query(
      `SELECT id, order_index, lat, lng, question, question_type, option_a, option_b, option_c
       FROM wp_waypoints WHERE route_id=\$1 AND order_index=\$2`,
      [routeId, nextIndex],
    );

    res.json({
      correct: true,
      completed: false,
      next_waypoint: nextWp.rows[0],
      current_index: nextIndex,
      total: total.rows[0].cnt,
      coins_earned: wpCoins,
    });
  } catch (e) {
    console.error("POST /api/wp/routes/:id/answer:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Highscore einer Route ────────────────────────────────────────────────────
app.get("/api/wp/routes/:id/score", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT c.player_code, c.time_seconds, c.completed_at,
             RANK() OVER (ORDER BY c.time_seconds ASC) AS rank
      FROM wp_completions c
      WHERE c.route_id = $1
      ORDER BY c.time_seconds ASC
      LIMIT 20
    `,
      [+req.params.id],
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /api/wp/routes/:id/score:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

app.get("/api/wp/stats/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const coinsRow = await pool.query(
      "SELECT coins FROM profiles WHERE code=$1",
      [code],
    );
    const coins = coinsRow.rows[0]?.coins || 0;

    const completions = await pool.query(
      "SELECT COUNT(*)::int AS n FROM wp_completions WHERE player_code=$1",
      [code],
    );
    const waypointsSolved = await pool.query(
      "SELECT COUNT(*)::int AS n FROM coin_transactions WHERE code=$1 AND reason='waypoint_solved'",
      [code],
    );

    res.json({
      coins,
      routes_completed: completions.rows[0].n,
      waypoints_solved: waypointsSolved.rows[0].n,
    });
  } catch (e) {
    console.error("GET /api/wp/stats/:code:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Meine Routen + Fortschritt ───────────────────────────────────────────────
app.get("/api/wp/my", async (req, res) => {
  const { code, token } = req.query;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code=$1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token)) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    const created = await pool.query(
      `SELECT r.*, COUNT(w.id)::int AS waypoint_count,
              COUNT(DISTINCT c.player_code)::int AS completion_count
       FROM wp_routes r
       LEFT JOIN wp_waypoints w ON w.route_id=r.id
       LEFT JOIN wp_completions c ON c.route_id=r.id
       WHERE r.code=$1 GROUP BY r.id ORDER BY r.created_at DESC`,
      [code],
    );
    const completions = await pool.query(
      `SELECT c.*, r.name AS route_name, r.difficulty,
              (SELECT COUNT(*)::int FROM wp_waypoints WHERE route_id=r.id) AS waypoint_count
       FROM wp_completions c JOIN wp_routes r ON r.id=c.route_id
       WHERE c.player_code=$1 ORDER BY c.completed_at DESC`,
      [code],
    );
    res.json({ created: created.rows, completions: completions.rows });
  } catch (e) {
    console.error("GET /api/wp/my:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Route erstellen ──────────────────────────────────────────────────────────
app.post("/api/wp/routes", async (req, res) => {
  const { code, token, name, description, difficulty } = req.body;
  if (!code || !token || !name)
    return res.status(400).json({ error: "code, token, name erforderlich" });
  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code=$1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token)) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    const { rows } = await pool.query(
      `INSERT INTO wp_routes (code, name, description, difficulty)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [
        code,
        name.slice(0, 80),
        description?.slice(0, 300) || null,
        Math.min(5, Math.max(1, +difficulty || 1)),
      ],
    );
    res.json({ success: true, route: rows[0] });
  } catch (e) {
    console.error("POST /api/wp/routes:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── WayPoint hinzufügen ──────────────────────────────────────────────────────

app.post("/api/wp/routes/:id/waypoints", async (req, res) => {
  const {
    code,
    token,
    lat,
    lng,
    question,
    question_type = "multiple_choice",
    option_a,
    option_b,
    option_c,
    correct_option,
    correct_text,
  } = req.body;
  const routeId = +req.params.id;

  if (!code || !token || !lat || !lng || !question) {
    return res.status(400).json({ error: "Grunddaten erforderlich" });
  }
  if (!["multiple_choice", "freitext"].includes(question_type)) {
    return res.status(400).json({ error: "Ungültiger Fragetyp" });
  }
  if (question_type === "multiple_choice") {
    if (!option_a || !option_b || !option_c || !correct_option) {
      return res
        .status(400)
        .json({ error: "Alle 3 Optionen + richtige Antwort erforderlich" });
    }
    if (!["a", "b", "c"].includes(correct_option)) {
      return res
        .status(400)
        .json({ error: "correct_option muss a, b oder c sein" });
    }
  } else if (question_type === "freitext") {
    if (!correct_text || !correct_text.trim()) {
      return res
        .status(400)
        .json({ error: "Richtige Antwort (Freitext) erforderlich" });
    }
  }

  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code=\$1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token)) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    const owns = await pool.query(
      "SELECT id FROM wp_routes WHERE id=\$1 AND code=\$2 AND published=false",
      [routeId, code],
    );
    if (!owns.rows.length)
      return res
        .status(403)
        .json({ error: "Route nicht gefunden oder bereits veröffentlicht" });

    const cnt = await pool.query(
      "SELECT COUNT(*)::int AS n FROM wp_waypoints WHERE route_id=\$1",
      [routeId],
    );
    const { rows } = await pool.query(
      `INSERT INTO wp_waypoints
         (route_id, order_index, lat, lng, question, question_type, option_a, option_b, option_c, correct_option, correct_text)
       VALUES (\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11) RETURNING id, order_index`,
      [
        routeId,
        cnt.rows[0].n,
        lat,
        lng,
        question.slice(0, 300),
        question_type,
        question_type === "multiple_choice" ? option_a.slice(0, 120) : null,
        question_type === "multiple_choice" ? option_b.slice(0, 120) : null,
        question_type === "multiple_choice" ? option_c.slice(0, 120) : null,
        question_type === "multiple_choice" ? correct_option : null,
        question_type === "freitext" ? correct_text.trim().slice(0, 200) : null,
      ],
    );
    res.json({ success: true, waypoint: rows[0] });
  } catch (e) {
    console.error("POST /api/wp/routes/:id/waypoints:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Route veröffentlichen ────────────────────────────────────────────────────
app.post("/api/wp/routes/:id/publish", async (req, res) => {
  const { code, token } = req.body;
  const routeId = +req.params.id;
  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code=$1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token)) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    // Mindestens 2 WayPoints erforderlich
    const cnt = await pool.query(
      "SELECT COUNT(*)::int AS n FROM wp_waypoints WHERE route_id=$1",
      [routeId],
    );
    if (cnt.rows[0].n < 2)
      return res
        .status(400)
        .json({ error: "Mindestens 2 WayPoints erforderlich" });

    await pool.query(
      "UPDATE wp_routes SET published=true WHERE id=$1 AND code=$2",
      [routeId, code],
    );
    console.log(`🗺️ WayPoint-Route veröffentlicht: ${routeId} von ${code}`);
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/wp/routes/:id/publish:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Route löschen ────────────────────────────────────────────────────────────
app.delete("/api/wp/routes/:id", async (req, res) => {
  const { code, token } = req.body;
  const routeId = +req.params.id;
  try {
    const auth = await pool.query(
      "SELECT token FROM profiles WHERE code=$1 AND token IS NOT NULL",
      [code],
    );
    if (!auth.rows.length || !auth.rows.some((r) => r.token === token)) {
      return res.status(403).json({ error: "Ungültiger Token" });
    }
    await pool.query("DELETE FROM wp_routes WHERE id=$1 AND code=$2", [
      routeId,
      code,
    ]);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/wp/routes/:id:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE SPOTS
// Mobile Profil-Spots – Creator setzt Standort manuell, Follower bekommen
// Push wenn Creator innerhalb 10km online geht.
// ══════════════════════════════════════════════════════════════════════════════

function liveHaversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371,
    dLat = ((lat2 - lat1) * Math.PI) / 180,
    dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function authCheck(code, token) {
  const r = await pool.query(
    "SELECT token FROM profiles WHERE code=$1 AND token IS NOT NULL",
    [code],
  );
  return r.rows.length && r.rows.some((row) => row.token === token);
}

// ── Live Spot erstellen ──────────────────────────────────────────────────────
app.post("/api/live-spots", async (req, res) => {
  const { code, token, name, description, category, avatar } = req.body;
  if (!code || !token || !name)
    return res.status(400).json({ error: "code, token, name erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    const lsToken = crypto.randomBytes(16).toString("hex");
    const { rows } = await pool.query(
      `INSERT INTO live_spots (token, creator_code, name, description, category, avatar)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        lsToken,
        code,
        name.slice(0, 80),
        description?.slice(0, 300) || null,
        category || null,
        avatar || null,
      ],
    );
    console.log(`📡 Live Spot erstellt: "${name}" von ${code}`);
    res.json({ success: true, spot: rows[0] });
  } catch (e) {
    console.error("POST /api/live-spots:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// Neue Route in server.js, neben den anderen live-spots Routen
app.delete("/api/live-spots/:id", async (req, res) => {
  const { code, token } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    const check = await pool.query(
      "SELECT id FROM live_spots WHERE id=$1 AND creator_code=$2",
      [req.params.id, code],
    );
    if (!check.rows.length)
      return res
        .status(404)
        .json({ error: "Nicht gefunden oder keine Berechtigung" });

    await pool.query("DELETE FROM live_followers WHERE live_spot_id=$1", [
      req.params.id,
    ]);
    await pool.query("DELETE FROM live_spots WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Alle online Live Spots (für Karte) ──────────────────────────────────────
app.get("/api/live-spots", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, token, creator_code, name, description, category, avatar,
              status, lat, lng, location_note, follower_count, updated_at
       FROM live_spots WHERE status = 'online' ORDER BY updated_at DESC`,
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /api/live-spots:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Meine Live Spots ─────────────────────────────────────────────────────────
// MUSS vor /:id stehen!
app.get("/api/live-spots/mine", async (req, res) => {
  const { code, token } = req.query;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    const { rows } = await pool.query(
      "SELECT * FROM live_spots WHERE creator_code=$1 ORDER BY created_at DESC",
      [code],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Live Spots denen ich folge ───────────────────────────────────────────────
app.get("/api/live-spots/following", async (req, res) => {
  const { code, token } = req.query;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    const { rows } = await pool.query(
      `SELECT ls.* FROM live_spots ls
       INNER JOIN live_followers lf ON lf.live_spot_id = ls.id
       WHERE lf.follower_code = $1 ORDER BY ls.status DESC, ls.updated_at DESC`,
      [code],
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Einzelner Live Spot (öffentlich) ────────────────────────────────────────
app.get("/api/live-spots/:id", async (req, res) => {
  try {
    const col = isNaN(req.params.id) ? "token" : "id";
    const { rows } = await pool.query(
      `SELECT id, token, creator_code, name, description, category, avatar,
              status, lat, lng, location_note, follower_count, updated_at
       FROM live_spots WHERE ${col}=$1`,
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ error: "Live Spot nicht gefunden" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Live gehen (Standort setzen + online schalten) ───────────────────────────
app.post("/api/live-spots/:id/golive", async (req, res) => {
  const { code, token, lat, lng, location_note } = req.body;
  if (!code || !token || lat == null || lng == null)
    return res
      .status(400)
      .json({ error: "code, token, lat, lng erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    const result = await pool.query(
      `UPDATE live_spots SET status='online', lat=$1, lng=$2,
       location_note=$3, updated_at=NOW()
       WHERE id=$4 AND creator_code=$5 RETURNING *`,
      [lat, lng, location_note || null, req.params.id, code],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Live Spot nicht gefunden" });

    const spot = result.rows[0];
    console.log(
      `📡 Live Spot online: "${spot.name}" @ ${lat.toFixed(4)},${lng.toFixed(4)}`,
    );

    // Push an Follower innerhalb 10km (fire-and-forget)
    sendLivePush(spot).catch(console.error);

    res.json({ success: true, spot });
  } catch (e) {
    console.error("POST /api/live-spots/:id/golive:", e.message);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Offline gehen ─────────────────────────────────────────────────────────────
app.post("/api/live-spots/:id/gooffline", async (req, res) => {
  const { code, token } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    await pool.query(
      `UPDATE live_spots SET status='offline', updated_at=NOW()
       WHERE id=$1 AND creator_code=$2`,
      [req.params.id, code],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Live Spot Profil bearbeiten ──────────────────────────────────────────────
app.put("/api/live-spots/:id", async (req, res) => {
  const { code, token, name, description, category, avatar } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    await pool.query(
      `UPDATE live_spots SET name=$1, description=$2, category=$3, avatar=$4, updated_at=NOW()
       WHERE id=$5 AND creator_code=$6`,
      [
        name?.slice(0, 80),
        description?.slice(0, 300) || null,
        category || null,
        avatar || null,
        req.params.id,
        code,
      ],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Folgen ────────────────────────────────────────────────────────────────────
app.post("/api/live-spots/:id/follow", async (req, res) => {
  const { code, token } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    await pool.query(
      `INSERT INTO live_followers (live_spot_id, follower_code) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, code],
    );
    await pool.query(
      "UPDATE live_spots SET follower_count = (SELECT COUNT(*) FROM live_followers WHERE live_spot_id=$1) WHERE id=$1",
      [req.params.id],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Entfolgen ────────────────────────────────────────────────────────────────
app.delete("/api/live-spots/:id/follow", async (req, res) => {
  const { code, token } = req.body;
  if (!code || !token)
    return res.status(400).json({ error: "code + token erforderlich" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    await pool.query(
      "DELETE FROM live_followers WHERE live_spot_id=$1 AND follower_code=$2",
      [req.params.id, code],
    );
    await pool.query(
      "UPDATE live_spots SET follower_count = (SELECT COUNT(*) FROM live_followers WHERE live_spot_id=$1) WHERE id=$1",
      [req.params.id],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ── Letzten Standort eines Nutzers aktualisieren (für 10km Push-Filter) ─────
app.post("/api/location/update", async (req, res) => {
  const { code, token, lat, lng } = req.body;
  if (!code || !token || lat == null || lng == null)
    return res.status(400).json({ error: "Pflichtfelder fehlen" });
  try {
    if (!(await authCheck(code, token)))
      return res.status(403).json({ error: "Ungültiger Token" });
    await pool.query(
      "UPDATE profiles SET last_lat=$1, last_lng=$2, last_seen=NOW() WHERE code=$3",
      [lat, lng, code],
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// Push an Follower innerhalb 10km wenn Live Spot online geht
async function sendLivePush(spot) {
  if (!spot.lat || !spot.lng) return;
  const { rows: followers } = await pool.query(
    `SELECT p.code, p.last_lat, p.last_lng, ps.endpoint, ps.p256dh, ps.auth
     FROM live_followers lf
     JOIN profiles p ON p.code = lf.follower_code
     LEFT JOIN push_subscriptions ps ON ps.code = p.code
     WHERE lf.live_spot_id = $1 AND ps.endpoint IS NOT NULL`,
    [spot.id],
  );
  const payload = JSON.stringify({
    title: `📡 ${spot.name} ist jetzt live!`,
    body: spot.location_note || "Tippe um den Standort zu sehen.",
    url: `/live-spot.html?id=${spot.id}`,
    tag: `live-${spot.id}`,
  });
  for (const f of followers) {
    // Push nur wenn Follower Standort bekannt und innerhalb 10km
    if (f.last_lat && f.last_lng) {
      const km = liveHaversineKm(
        +f.last_lat,
        +f.last_lng,
        +spot.lat,
        +spot.lng,
      );
      if (km > 10) continue;
    }
    webpush
      .sendNotification(
        { endpoint: f.endpoint, keys: { p256dh: f.p256dh, auth: f.auth } },
        payload,
      )
      .catch(async (err) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool
            .query("DELETE FROM push_subscriptions WHERE endpoint=$1", [
              f.endpoint,
            ])
            .catch(() => {});
        }
      });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DONATIONS
// ══════════════════════════════════════════════════════════════════════════════

app.post("/api/donate/checkout", async (req, res) => {
  const amount = parseFloat(req.body.amount);
  console.log("Empfangener Betrag:", req.body.amount, typeof req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Ungültiger Betrag" });
  }

  const reference = crypto.randomUUID();

  try {
    console.log("Starte SumUp-Request..."); // ← neu
    const r = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUMUP_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        checkout_reference: reference,
        amount: amount,
        currency: "EUR",
        merchant_code: process.env.SUMUP_MERCHANT_CODE,
        description: "SpotMe Caching · Spende",
        return_url: "https://spotme-caching.github.io/?donation=danke",
        callback_url:
          "https://spotme-chat-obom.onrender.com/api/donate/callback",
        hosted_checkout: { enabled: true },
      }),
    });

    console.log("SumUp Antwort erhalten, Status:", r.status); // ← neu
    const data = await r.json();
    console.log("SumUp Antwort-Body:", JSON.stringify(data)); // ← neu

    if (!r.ok) {
      console.error("SumUp Checkout Fehler:", data);
      return res.status(502).json({ error: "SumUp nicht erreichbar" });
    }

    await pool.query(
      "INSERT INTO donations (reference, amount, status) VALUES ($1, $2, $3)",
      [reference, amount, "pending"],
    );

    res.json({ url: data.hosted_checkout_url });
  } catch (err) {
    console.error("Checkout-Fehler:", err.message, err.stack); // ← erweitert
    res.status(500).json({ error: "Server-Fehler" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PING & START
// ══════════════════════════════════════════════════════════════════════════════

app.all("/ping", (req, res) => res.status(204).end());
app.all("/api/ping", (req, res) => res.status(204).end());
app.get("/", (req, res) => res.send("SpotMe PG-Server läuft ✅"));

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    server.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ DB-Initialisierung fehlgeschlagen:", e.message);
    process.exit(1);
  });
