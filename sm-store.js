/* SpotMe – gemeinsamer lokaler Speicher ("Local First")
 *
 * Eine Stelle für alles, was Spot-Seiten zuletzt gesehen haben:
 *   SMStore.get(kind, id, url)  → zeigt gespeicherten Stand, wenn der Server nicht antwortet
 *   SMStore.save / load / forget
 *   SMStore.listSpot(id)        → Platz Spot aus der Karten-Liste (IndexedDB "SpotMeDB")
 *   SMStore.retry(fn)           → lädt neu, sobald Netz zurück ist (online-Ereignis oder alle 15 s)
 *   SMStore.banner(ts)          → Hinweis "Keine Verbindung – gespeicherter Stand von …"
 *
 * Regeln:
 *  - Alles ist an das Profil gebunden (Code im Schlüssel) und beginnt mit "sm_cache_" →
 *    "Auf meinem Gerät löschen" (datenschutz.html) entfernt es.
 *  - Es wird immer genau das gespeichert, was der Server diesem Profil gezeigt hat
 *    (ungefährer oder genauer Ort). Bei jedem erfolgreichen Abruf wird überschrieben.
 *  - Höchstens 80 Einträge je Art, älter als 60 Tage fliegt raus.
 */
(function () {
  var PRE = 'sm_cache_', MAX = 80, TTL = 60 * 86400000;

  function viewer() { try { return localStorage.getItem('sm_code') || '-'; } catch (e) { return '-'; } }
  function key(kind, id) { return PRE + kind + '_' + id + '_' + viewer(); }

  function load(kind, id) {
    try {
      var v = JSON.parse(localStorage.getItem(key(kind, id)) || 'null');
      return v && v.d != null ? v : null;
    } catch (e) { return null; }
  }

  function prune(kind) {
    try {
      var pre = PRE + kind + '_', list = [], now = Date.now();
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(pre) === 0) {
          var t = 0; try { t = (JSON.parse(localStorage.getItem(k)) || {}).t || 0; } catch (e) {}
          list.push([k, t]);
        }
      }
      list.sort(function (a, b) { return b[1] - a[1]; });
      list.forEach(function (x, n) { if (n >= MAX || now - x[1] > TTL) localStorage.removeItem(x[0]); });
    } catch (e) {}
  }

  function save(kind, id, d) {
    var s = JSON.stringify({ t: Date.now(), d: d });
    try { localStorage.setItem(key(kind, id), s); }
    catch (e) { prune(kind); try { localStorage.setItem(key(kind, id), s); } catch (e2) {} return; }
    prune(kind);
  }

  function forget(kind, id) { try { localStorage.removeItem(key(kind, id)); } catch (e) {} }

  // Platz Spot aus der Karten-Liste (dieselbe Datenbank, die die Hauptkarte offline nutzt)
  function listSpot(id) {
    return new Promise(function (res) {
      try {
        var q = indexedDB.open('SpotMeDB');
        q.onerror = function () { res(null); };
        q.onupgradeneeded = function () { try { q.transaction.abort(); } catch (e) {} res(null); };
        q.onsuccess = function () {
          var d = q.result;
          if (!d.objectStoreNames.contains('spots')) { d.close(); return res(null); }
          var g = d.transaction('spots').objectStore('spots').get(Number(id));
          g.onsuccess = function () { d.close(); res(g.result || null); };
          g.onerror = function () { d.close(); res(null); };
        };
      } catch (e) { res(null); }
    });
  }

  // fetch mit Zeitlimit
  function tfetch(url, opts, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var tm = ctl ? setTimeout(function () { ctl.abort(); }, ms || 8000) : null;
    var o = {}; for (var k in (opts || {})) o[k] = opts[k];
    if (ctl) o.signal = ctl.signal;
    return fetch(url, o).then(function (r) { if (tm) clearTimeout(tm); return r; },
      function (e) { if (tm) clearTimeout(tm); throw e; });
  }

  /* Holt url (JSON). Ergebnis: { data, offlineTs, notFound }
   *  - Server antwortet → frische Daten, werden gespeichert
   *  - 404/410         → notFound, Speicher wird gelöscht
   *  - sonst           → gespeicherter Stand (offlineTs = Zeitpunkt), sonst opts.fallback()
   * Mit gespeichertem Stand wartet die Seite höchstens 6 s (offline erkannt: 1,5 s). */
  function get(kind, id, url, opts) {
    opts = opts || {};
    var c = load(kind, id);
    var wait = c ? (navigator.onLine === false ? 1500 : 6000) : (opts.noCacheWait || 0);
    return new Promise(function (resolve) {
      function fail() {
        if (c) return resolve({ data: c.d, offlineTs: c.t || 1, notFound: false });
        if (typeof opts.fallback === 'function') {
          return Promise.resolve(opts.fallback()).then(function (f) {
            resolve(f ? { data: f, offlineTs: 1, notFound: false } : { data: null, offlineTs: 0, notFound: false });
          }, function () { resolve({ data: null, offlineTs: 0, notFound: false }); });
        }
        resolve({ data: null, offlineTs: 0, notFound: false });
      }
      tfetch(url, opts.fetch || {}, wait || 60000).then(function (r) {
        if (r.status === 404 || r.status === 410) { forget(kind, id); return resolve({ data: null, offlineTs: 0, notFound: true }); }
        if (!r.ok) throw new Error('server');
        return r.json().then(function (d) { save(kind, id, d); resolve({ data: d, offlineTs: 0, notFound: false }); });
      }).catch(fail);
    });
  }

  var rt = null;
  function retry(fn) {
    if (rt) return; rt = true;
    var iv;
    function go() { window.removeEventListener('online', go); clearInterval(iv); rt = null; fn(); }
    window.addEventListener('online', go);
    iv = setInterval(function () { if (!document.hidden) go(); }, 15000);
  }

  function banner(ts) {
    if (!ts) return '';
    var d = new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return '<div style="font-size:0.74rem;color:var(--muted2,#94a3b8);border:1px dashed var(--muted2,#94a3b8);border-radius:10px;padding:0.5rem 0.7rem;margin-bottom:0.6rem;">📴 Keine Verbindung – gespeicherter Stand von ' + d + '</div>';
  }

  window.SMStore = { get: get, save: save, load: load, forget: forget, listSpot: listSpot, retry: retry, banner: banner, tfetch: tfetch };
})();
