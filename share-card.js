// Teilen-Link mit Vorschaubild: /s/<Handle>  → Vorschau-Seite für Bots (OG-Tags), Menschen gehen sofort weiter in den Messenger
// /s/<Handle>/card.png → 1200×630 Bild: share/share-template.png + @Handle + Name (Vorlage einfach austauschen)
// @resvg/resvg-js ist optional: fehlt es, wird die Vorlage ohne Text ausgeliefert.
const fs = require("fs"), path = require("path");
const BASE = process.env.SHARE_BASE || "https://spotme-caching.github.io/chat/";
const DIR = path.join(__dirname, "share");
let Resvg = null; try { Resvg = require("@resvg/resvg-js").Resvg; } catch (e) { console.log("share-card: @resvg/resvg-js fehlt → Vorlage ohne Text"); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TPL = () => { try { return fs.readFileSync(path.join(DIR, "share-template.png")); } catch (e) { return null; } };
const cache = new Map(), hits = new Map();
setInterval(() => hits.clear(), 60000).unref();

module.exports = function (app, { pool, decrypt, handleRe }) {
  async function lookup(raw) {
    const name = String(raw || "").replace(/^@/, "");
    if (!handleRe.test(name)) return null;
    const r = await pool.query("SELECT h.code, h.display, p.name FROM messenger_handles h JOIN profiles p ON p.code=h.code WHERE h.handle=$1", [name.toLowerCase()]);
    if (!r.rows.length) return null;
    let nm = ""; try { nm = decrypt(r.rows[0].name) || ""; } catch (e) {}
    return { code: r.rows[0].code, handle: r.rows[0].display, name: nm };
  }
  // "X empfiehlt dir Y": nur wenn Y Empfehlungen erlaubt hat UND X und Y gegenseitig verifiziert sind (sonst keine Behauptung in der Vorschau)
  async function recommender(von, y, why) {
    const no = (r) => { if (why) why.reason = r; return null; };
    try {
      if (!von) return no("kein ?von= im Link");
      if (!y) return no("Empfohlener hat keinen @Handle");
      const v = await lookup(von); if (!v) return no("@" + von + " existiert nicht als Handle (der Empfehlende braucht einen @Handle)");
      if (v.code === y.code) return no("von = der Empfohlene selbst");
      const rc = await pool.query("SELECT text FROM messenger_pubrec WHERE code=$1", [y.code]); if (!rc.rows.length) return no("@" + y.handle + " hat „Öffentlich per Link empfehlbar“ NICHT eingeschaltet");
      const lo = v.code < y.code ? v.code : y.code, hi = v.code < y.code ? y.code : v.code;
      const ok = await pool.query("SELECT 1 FROM messenger_verified WHERE lo=$1 AND hi=$2 AND lo_ok AND hi_ok", [lo, hi]);
      if (!ok.rows.length) return no("Server kennt die Verifizierung von @" + v.handle + " und @" + y.handle + " noch nicht beidseitig (beide einmal den Hub öffnen/online sein)");
      return { handle: v.handle, text: rc.rows[0].text || "" };
    } catch (e) { return no("Fehler: " + e.message); }
  }
  function limited(req, res) {
    const ip = req.headers["cf-connecting-ip"] || req.ip || "x"; const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > 120) { res.status(429).send("Zu viele Anfragen"); return true; } return false;
  }
  function render(h) {
    const key = h.handle + "|" + h.name + "|" + (h.von || ""), c = cache.get(key);
    if (c && c.t > Date.now() - 600000) return c.png;
    const tpl = TPL(); if (!tpl || !Resvg) return tpl;
    const hs = "@" + h.handle, hSize = Math.max(40, Math.min(120, Math.floor(540 / (hs.length * 0.6))));
    const nm = h.name.length > 24 ? h.name.slice(0, 23) + "…" : h.name;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630">
<image href="data:image/png;base64,${tpl.toString("base64")}" width="1200" height="630"/>
<text x="600" y="330" font-family="Outfit" font-weight="700" font-size="${hSize}" fill="#ffb347">${esc(hs)}</text>
${nm ? `<text x="604" y="400" font-family="Outfit" font-weight="400" font-size="44" fill="#e8eefc">${esc(nm)}</text>` : ""}
<text x="604" y="470" font-family="Outfit" font-weight="400" font-size="30" fill="#7fe3d6">${esc(h.von ? "empfohlen von @" + h.von : "lädt dich zum Chat ein")}</text></svg>`;
    const png = new Resvg(svg, { font: { fontFiles: [path.join(DIR, "outfit-700.ttf"), path.join(DIR, "outfit-400.ttf")], loadSystemFonts: false, defaultFontFamily: "Outfit" } }).render().asPng();
    if (cache.size > 300) cache.clear(); cache.set(key, { t: Date.now(), png });
    return png;
  }
  // 🌟 Sternbild-Bild: /s/<Handle>/card.png?stern=N  (nur Anzahl + Stufe, keine Namen; N kommt vom Client und wird nur angezeigt)
  const LEVELS = [[0, "Noch dunkel"], [1, "Funke"], [3, "Sternbild"], [6, "Konstellation"], [10, "Galaxie"]];
  const levelOf = (n) => LEVELS.filter((l) => n >= l[0]).pop()[1];
  const starN = (q) => { const n = parseInt(q, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 999) : null; };
  function renderStars(h, n) {
    const key = "stern|" + h.handle + "|" + n, c = cache.get(key);
    if (c && c.t > Date.now() - 600000) return c.png;
    if (!Resvg) return TPL();
    let seed = 7; for (const ch of h.handle) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const shown = Math.min(n, 14), pts = [];
    for (let i = 0; i < shown; i++) pts.push([90 + rnd() * 1020, 130 + rnd() * 250]);
    pts.sort((a, b) => a[0] - b[0]);
    const lines = pts.slice(1).map((p, i) => `<line x1="${pts[i][0].toFixed(0)}" y1="${pts[i][1].toFixed(0)}" x2="${p[0].toFixed(0)}" y2="${p[1].toFixed(0)}" stroke="#8fc4ff" stroke-opacity=".55" stroke-width="3"/>`).join("");
    const star = (x, y, r) => { let d = ""; for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r; d += (k ? "L" : "M") + (x + rr * Math.cos(a)).toFixed(1) + " " + (y + rr * Math.sin(a)).toFixed(1); } return `<path d="${d}Z" fill="#ffd45a"/>`; };
    const dots = pts.map((p) => star(p[0], p[1], 20)).join("");
    const bg = Array.from({ length: 40 }, () => `<circle cx="${(rnd() * 1200).toFixed(0)}" cy="${(rnd() * 630).toFixed(0)}" r="${(1 + rnd() * 2).toFixed(1)}" fill="#fff" fill-opacity="${(0.2 + rnd() * 0.5).toFixed(2)}"/>`).join("");
    const hs = "@" + h.handle, hSize = Math.max(36, Math.min(64, Math.floor(900 / (hs.length * 0.6))));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><radialGradient id="g" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="#14224a"/><stop offset="1" stop-color="#04060f"/></radialGradient></radialGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>${bg}${lines}${dots}
<text x="600" y="470" text-anchor="middle" font-family="Outfit" font-weight="700" font-size="64" fill="#ffd45a">${n === 0 ? "Mein Sternbild beginnt" : n + (n === 1 ? " Stern" : " Sterne") + " · " + esc(levelOf(n))}</text>
<text x="600" y="540" text-anchor="middle" font-family="Outfit" font-weight="400" font-size="${hSize}" fill="#e8eefc">${esc(hs)}</text></svg>`.replace("</radialGradient></radialGradient>", "</radialGradient>");
    const png = new Resvg(svg, { font: { fontFiles: [path.join(DIR, "outfit-700.ttf"), path.join(DIR, "outfit-400.ttf")], loadSystemFonts: false, defaultFontFamily: "Outfit" } }).render().asPng();
    if (cache.size > 300) cache.clear(); cache.set(key, { t: Date.now(), png });
    return png;
  }
  app.get("/s/:name/card.png", async (req, res) => {
    if (limited(req, res)) return;
    try {
      const h = (await lookup(req.params.name)) || { handle: "", name: "" };
      if (h.handle && req.query.von) { const rv = await recommender(String(req.query.von).slice(0, 30), h); h.von = rv ? rv.handle : null; }
      const sn = h.handle ? starN(req.query.stern) : null;
      const png = h.handle ? (sn != null ? renderStars(h, sn) : render(h)) : TPL();
      if (!png) return res.status(404).end();
      res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=600" }).send(png);
    } catch (e) { console.error("share card:", e.message); res.status(500).end(); }
  });
  // Diagnose (nur mit Render-Env SHARE_DEBUG=1): sagt, warum eine Empfehlung NICHT angezeigt wird
  app.get("/s/:name/check", async (req, res) => {
    if (process.env.SHARE_DEBUG !== "1") return res.status(404).end();
    const why = {}; const h = await lookup(req.params.name).catch(() => null);
    const r = await recommender(String(req.query.von || "").slice(0, 30), h, why);
    res.json({ empfehlung: !!r, grund: r ? "alles ok" : why.reason, text: r ? r.text : null });
  });
  app.get("/s/:name", async (req, res) => {
    if (limited(req, res)) return;
    let h = null; try { h = await lookup(req.params.name); } catch (e) {}
    const rv = h && req.query.von ? await recommender(String(req.query.von).slice(0, 30), h) : null, von = rv ? rv.handle : null;
    const self = (process.env.PUBLIC_API_BASE || (req.protocol + "://" + req.get("host"))) + "/s/" + encodeURIComponent(req.params.name);
    const sn = h ? starN(req.query.stern) : null;
    const q = sn != null ? "?stern=" + sn : von ? "?von=" + encodeURIComponent(von) : "";
    const target = BASE + (h ? "?" + encodeURIComponent(h.handle) + (von ? "&von=" + encodeURIComponent(von) : "") : "landing.html");
    const title = h && sn != null ? `🌟 @${h.handle}: ${sn} ${sn === 1 ? "Stern" : "Sterne"} im Sternbild` : h ? `@${h.handle} auf dem SpotMe Messenger` : "SpotMe Messenger – Schreiben ohne Nummer, ohne E-Mail";
    const desc = rv && rv.text ? rv.text.slice(0, 300) : h ? `${von ? "@" + von + " empfiehlt dir " + (h.name || "@" + h.handle) + ": " : h.name ? h.name + " lädt dich ein: " : ""}Anonym und privat schreiben – ohne Telefonnummer, ohne E-Mail.` : "Anonym und privat schreiben: nur ein Name, keine Telefonnummer, keine Werbung.";
    res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }).send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:site_name" content="SpotMe Messenger"><meta property="og:url" content="${esc(self)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(self + "/card.png" + q)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(self + "/card.png" + q)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}"></head><body style="background:#0a1020;color:#e8eefc;font-family:sans-serif;text-align:center;padding:40px"><p>Weiter zum Messenger …</p><p><a style="color:#ffb347" href="${esc(target)}">Hier tippen, falls nichts passiert</a></p><script>location.replace(${JSON.stringify(target)})</script></body></html>`);
  });
};
