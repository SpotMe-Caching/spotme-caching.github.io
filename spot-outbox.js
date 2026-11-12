/* SpotMe Postausgang – Spots anlegen UND Änderungen (Favorit, Pausieren, Löschen, Folgen) offline vormerken, später automatisch senden.
 *
 * - Jeder neue Spot wird ZUERST lokal gespeichert (IndexedDB), dann gesendet → nichts geht verloren
 * - client_id = Doppel-Schutz: wiederholtes Senden erzeugt keinen zweiten Spot
 * - Netzfehler/5xx/429 → bleibt wartend, nächster Versuch bei "online", App-Start, Sichtbarkeit, alle 60 s
 * - 4xx (z. B. ungültig) → bleibt als "nicht gesendet" sichtbar, wird nicht endlos wiederholt
 * - Änderungen melden per Event 'spotoutbox' (detail: {sent, failed, left, failedActs})
 * - Änderungs-Aktionen (act): je Ziel nur der letzte Wunsch zählt (Schlüssel a_<gruppe>_<ziel>), alle wiederholungssicher
 *   (Favorit setzen/entfernen, Spot aktiv/pausiert, Spot löschen, Wochen-Spot löschen, Live Spot folgen/entfolgen)
 */
(function () {
  'use strict';
  var DB = 'SpotMeOutbox', STORE = 'q';
  var flushing = null;

  function cfg() {
    var c = window.SM_CHAT_CFG || {};
    return {
      api: c.api || window.API || 'https://spotme-chat-obom.onrender.com/api',
      code: c.code || localStorage.getItem('sm_code') || '',
      token: c.token || localStorage.getItem('sm_token') || ''
    };
  }
  function open() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: 'cid' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(STORE, mode), out = fn(t.objectStore(STORE));
        t.oncomplete = function () { db.close(); res(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = t.onabort = function () { db.close(); rej(t.error); };
      });
    });
  }
  function all() { return tx('readonly', function (s) { return s.getAll(); }).then(function (v) { return v || []; }, function () { return []; }); }
  function put(item) { return tx('readwrite', function (s) { return s.put(item); }); }
  function del(cid) { return tx('readwrite', function (s) { return s.delete(cid); }); }
  function newId() {
    var a = new Uint8Array(9);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else for (var i = 0; i < 9; i++) a[i] = Math.random() * 256;
    return 's' + Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function emit(d) { try { window.dispatchEvent(new CustomEvent('spotoutbox', { detail: d })); } catch (e) {} }
  function tfetch(url, opts, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 15000) : null;
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).finally(function () { if (t) clearTimeout(t); });
  }

  // ── Änderungs-Aktionen ─────────────────────────────────────────────
  var ACTS = {
    'fav-add':       { g: 'fav',    m: 'POST',   u: function (it) { return '/favorites'; },                      b: function (it) { return { spot_id: /^\d+$/.test(it.target) ? Number(it.target) : it.target }; } },
    'fav-del':       { g: 'fav',    m: 'DELETE', u: function (it) { return '/favorites/' + it.target; },         b: function () { return {}; } },
    'spot-active':   { g: 'active', m: 'PATCH',  u: function (it) { return '/userspots/' + it.target + '/toggle'; }, b: function (it) { return { active: !!it.val }; } },
    'spot-del':      { g: 'del',    m: 'DELETE', u: function (it) { return '/userspots/' + it.target; },         b: function () { return {}; } },
    'weekly-del':    { g: 'wdel',   m: 'DELETE', u: function (it) { return '/weekly-spots/' + it.target; },      b: function () { return {}; } },
    'live-follow':   { g: 'follow', m: 'POST',   u: function (it) { return '/live-spots/' + it.target + '/follow'; }, b: function () { return {}; } },
    'live-unfollow': { g: 'follow', m: 'DELETE', u: function (it) { return '/live-spots/' + it.target + '/follow'; }, b: function () { return {}; } }
  };
  var failedActs = [];
  async function transmitAct(it) {
    var c = cfg(), d = ACTS[it.type];
    if (!d) { await del(it.cid); return 'sent'; }
    if (!c.token) return 'retry';
    try {
      var res = await tfetch(c.api + d.u(it), {
        method: d.m, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ code: c.code, token: c.token }, d.b(it)))
      }, 15000);
      if (res.ok) { await del(it.cid); return 'sent'; }
      // schon weg / nichts mehr zu tun → gilt als erledigt
      if (res.status === 404 && /-del$|unfollow$/.test(it.type)) { await del(it.cid); return 'sent'; }
      var perm = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
      if (perm) {
        var err = ''; try { err = (await res.json()).error || ''; } catch (e) {}
        await del(it.cid);
        failedActs.push({ type: it.type, target: it.target, err: err || ('Fehler ' + res.status) });
        return 'failed';
      }
      return 'retry';
    } catch (e) { return 'retry'; }
  }
  function isAct(it) { return !!it.type; }

  // Einen Eintrag senden → 'sent' | 'failed' (dauerhaft) | 'retry' (später nochmal)
  async function transmit(it) {
    if (isAct(it)) return transmitAct(it);
    var c = cfg();
    if (!c.token) return 'retry'; // nicht angemeldet → warten
    try {
      var body = Object.assign({}, it.payload, { code: it.payload.code || c.code, token: c.token, client_id: it.cid });
      var res = await tfetch(c.api + '/userspots', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }, 20000);
      var d = {};
      try { d = await res.json(); } catch (e) {}
      if (res.ok && d.success) { await del(it.cid); return 'sent'; }
      var perm = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
      it.st = perm ? 'failed' : 'pending';
      it.err = d.error || ('Fehler ' + res.status);
      await put(it);
      return perm ? 'failed' : 'retry';
    } catch (e) {
      return 'retry'; // kein Netz
    }
  }

  // Alles Wartende senden. Nie parallel. Optional includeFailed = auch "nicht gesendete" nochmal versuchen.
  function flush(includeFailed) {
    if (flushing) return flushing;
    flushing = (async function () {
      var sent = 0, failed = 0, left = 0;
      var items = (await all()).sort(function (a, b) { return a.ts - b.ts; });
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.st === 'failed' && !includeFailed) { failed++; continue; }
        var r = await transmit(it);
        if (r === 'sent') sent++;
        else if (r === 'failed') failed++;
        else { left += items.length - i; break; } // Netz weg → Rest bleibt, nicht weiter hämmern
      }
      var d = { sent: sent, failed: failed, left: left, failedActs: failedActs.splice(0) };
      if (sent || d.failedActs.length) emit(d);
      return d;
    })().finally(function () { flushing = null; });
    return flushing;
  }

  // Neuen Spot übergeben. Rückgabe: { sent:true } | { queued:true } | { error:'…' }
  async function submit(payload) {
    var it = { cid: newId(), ts: Date.now(), st: 'pending', payload: payload };
    try { await put(it); } catch (e) { return { error: 'Lokaler Speicher nicht verfügbar' }; }
    var r = await transmit(it);
    if (r === 'sent') return { sent: true };
    if (r === 'failed') { var cur = (await all()).filter(function (x) { return x.cid === it.cid; })[0]; await del(it.cid); return { error: (cur && cur.err) || 'Abgelehnt' }; }
    return { queued: true };
  }


  // Änderung vormerken und gleich versuchen. Rückgabe: { sent:true } | { queued:true } | { error:'…' }
  async function act(type, target, val) {
    var d = ACTS[type]; if (!d) return { error: 'Unbekannte Aktion' };
    target = String(target);
    var it = { cid: 'a_' + d.g + '_' + target, ts: Date.now(), st: 'pending', type: type, target: target, val: val, code: cfg().code };
    try {
      if (type === 'spot-del') await del('a_active_' + target); // Löschen ersetzt ein wartendes Pausieren
      await put(it);
    } catch (e) { return { error: 'Lokaler Speicher nicht verfügbar' }; }
    var r = await transmit(it);
    if (r === 'sent') return { sent: true };
    if (r === 'failed') { var f = failedActs.splice(0); return { error: (f[0] && f[0].err) || 'Abgelehnt' }; }
    emit({ sent: 0, failed: 0, left: 1 });
    return { queued: true };
  }
  // Wartende Änderungen dieses Profils
  async function acts() {
    var c = cfg();
    return (await all()).filter(function (it) { return isAct(it) && (!it.code || it.code === c.code); });
  }

  // Wartende Spots in Karten-Format (für Anzeige)
  async function asSpots() {
    var c = cfg();
    return (await all()).filter(function (it) { return !isAct(it) && it.payload && (it.payload.code || c.code) === c.code; }).map(function (it) {
      var p = it.payload;
      return { id: 'p_' + it.cid, cid: it.cid, pending: true, failed: it.st === 'failed', err: it.err || null,
        code: p.code || c.code, lat: Number(p.lat), lng: Number(p.lng), name: p.name, description: p.description || '',
        wishTag: p.wishTag, image: p.image || null, area_type: p.area_type || null, created_at: it.ts, active: true };
    });
  }
  function discard(cid) { return del(cid).then(function () { emit({ sent: 0, failed: 0, left: 0 }); }); }
  function retryNow() { return flush(true); }

  window.addEventListener('online', function () { flush(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });
  setInterval(function () { if (!document.hidden && navigator.onLine !== false) flush(); }, 60000);
  setTimeout(function () { flush(); }, 1500);

  window.SpotOutbox = { act: act, acts: acts, submit: submit, flush: flush, asSpots: asSpots, discard: discard, retryNow: retryNow, all: all };
})();
