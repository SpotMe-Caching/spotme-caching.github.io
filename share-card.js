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
    const r = await pool.query("SELECT h.display, p.name FROM messenger_handles h JOIN profiles p ON p.code=h.code WHERE h.handle=$1", [name.toLowerCase()]);
    if (!r.rows.length) return null;
    let nm = ""; try { nm = decrypt(r.rows[0].name) || ""; } catch (e) {}
    return { handle: r.rows[0].display, name: nm };
  }
  function limited(req, res) {
    const ip = req.headers["cf-connecting-ip"] || req.ip || "x"; const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > 120) { res.status(429).send("Zu viele Anfragen"); return true; } return false;
  }
  function render(h) {
    const key = h.handle + "|" + h.name, c = cache.get(key);
    if (c && c.t > Date.now() - 600000) return c.png;
    const tpl = TPL(); if (!tpl || !Resvg) return tpl;
    const hs = "@" + h.handle, hSize = Math.max(40, Math.min(120, Math.floor(540 / (hs.length * 0.6))));
    const nm = h.name.length > 24 ? h.name.slice(0, 23) + "…" : h.name;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630">
<image href="data:image/png;base64,${tpl.toString("base64")}" width="1200" height="630"/>
<text x="600" y="330" font-family="Outfit" font-weight="700" font-size="${hSize}" fill="#ffb347">${esc(hs)}</text>
${nm ? `<text x="604" y="400" font-family="Outfit" font-weight="400" font-size="44" fill="#e8eefc">${esc(nm)}</text>` : ""}
<text x="604" y="470" font-family="Outfit" font-weight="400" font-size="30" fill="#7fe3d6">lädt dich zum Chat ein</text></svg>`;
    const png = new Resvg(svg, { font: { fontFiles: [path.join(DIR, "outfit-700.ttf"), path.join(DIR, "outfit-400.ttf")], loadSystemFonts: false, defaultFontFamily: "Outfit" } }).render().asPng();
    if (cache.size > 300) cache.clear(); cache.set(key, { t: Date.now(), png });
    return png;
  }
  app.get("/s/:name/card.png", async (req, res) => {
    if (limited(req, res)) return;
    try {
      const h = (await lookup(req.params.name)) || { handle: "", name: "" };
      const png = h.handle ? render(h) : TPL();
      if (!png) return res.status(404).end();
      res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=600" }).send(png);
    } catch (e) { console.error("share card:", e.message); res.status(500).end(); }
  });
  app.get("/s/:name", async (req, res) => {
    if (limited(req, res)) return;
    let h = null; try { h = await lookup(req.params.name); } catch (e) {}
    const self = (process.env.PUBLIC_API_BASE || (req.protocol + "://" + req.get("host"))) + "/s/" + encodeURIComponent(req.params.name);
    const target = BASE + (h ? "?" + encodeURIComponent(h.handle) : "landing.html");
    const title = h ? `@${h.handle} auf dem SpotMe Messenger` : "SpotMe Messenger – Schreiben ohne Nummer, ohne E-Mail";
    const desc = h ? `${h.name ? h.name + " lädt dich ein: " : ""}Anonym und privat schreiben – ohne Telefonnummer, ohne E-Mail.` : "Anonym und privat schreiben: nur ein Name, keine Telefonnummer, keine Werbung.";
    res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }).send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:site_name" content="SpotMe Messenger"><meta property="og:url" content="${esc(self)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(self)}/card.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(self)}/card.png">
<meta http-equiv="refresh" content="0;url=${esc(target)}"></head><body style="background:#0a1020;color:#e8eefc;font-family:sans-serif;text-align:center;padding:40px"><p>Weiter zum Messenger …</p><p><a style="color:#ffb347" href="${esc(target)}">Hier tippen, falls nichts passiert</a></p><script>location.replace(${JSON.stringify(target)})</script></body></html>`);
  });
};
