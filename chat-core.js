/* SpotMe Chat-Kern – gemeinsam für index.html, spot.html, live-spot.html
 *
 * Zuverlässigkeit:
 *  - Token bei Senden/Abholen (Server verlangt ihn)
 *  - Nachrichten haben Status: sending → sent | failed (mit "erneut senden")
 *  - client_id = Idempotenz: Wiederholung erzeugt keine Doppel-Nachricht
 *  - Abruf ohne Datenverlust: erst lokal speichern, dann /ack
 *  - Dedupe über Server-ID (sid) statt Zeitfenster-Raten
 *  - ein gemeinsamer Abruf (kein Wettlauf zwischen mehreren Pollern)
 */
(function () {
  'use strict';
  var PREFIX = 'sm_local_msg_';
  var MAX_LOCAL = 500;           // pro Chat lokal behalten
  var pulling = false;
  var flushing = false;

  function cfg() {
    var c = window.SM_CHAT_CFG || {};
    return {
      api:   c.api   || window.API || 'https://spotme-chat-obom.onrender.com/api',
      code:  c.code  || localStorage.getItem('sm_code') || '',
      token: c.token || localStorage.getItem('sm_token') || ''
    };
  }
  function room(a, b) { return [a, b].sort().join('-'); }
  function load(r) {
    try { var v = JSON.parse(localStorage.getItem(PREFIX + r) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function save(r, msgs) {
    if (msgs.length > MAX_LOCAL) msgs = msgs.slice(-MAX_LOCAL);
    try { localStorage.setItem(PREFIX + r, JSON.stringify(msgs)); return true; }
    catch (e) {
      // Speicher voll → älteste Hälfte verwerfen und nochmal versuchen
      try { localStorage.setItem(PREFIX + r, JSON.stringify(msgs.slice(-Math.floor(MAX_LOCAL / 4)))); return true; }
      catch (e2) { return false; }
    }
  }
  function newId() {
    var a = new Uint8Array(9);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function timeoutFetch(url, opts, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 12000) : null;
    opts = opts || {};
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).finally(function () { if (t) clearTimeout(t); });
  }
  function patchMsg(r, cid, patch) {
    var msgs = load(r);
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].cid === cid) { for (var k in patch) msgs[i][k] = patch[k]; break; }
    }
    save(r, msgs);
  }

  // Eine Nachricht an den Server übergeben (einmal). Ergebnis: 'sent' | 'failed'
  async function transmit(partner, m, myName) {
    var c = cfg();
    var r = room(c.code, partner);
    if (!c.token) { patchMsg(r, m.cid, { st: 'failed', err: 'Nicht angemeldet' }); return 'failed'; }
    try {
      var res = await timeoutFetch(c.api + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: partner, sender_code: c.code, sender_name: myName || c.code,
          message: m.text, spot_type: 'caching_chat', token: c.token, client_id: m.cid
        })
      }, 15000);
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (res.ok && data.success) {
        patchMsg(r, m.cid, { st: data.delivered ? 'delivered' : 'sent', sid: data.id, text: data.message || m.text, err: null });
        return 'sent';
      }
      // 4xx = dauerhaft abgelehnt (nicht blind wiederholen), 5xx/429 = später nochmal
      var perm = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
      patchMsg(r, m.cid, { st: 'failed', perm: perm, err: data.error || ('Fehler ' + res.status) });
      return 'failed';
    } catch (e) {
      patchMsg(r, m.cid, { st: 'failed', err: 'Keine Verbindung' });
      return 'failed';
    }
  }

  // Neue Nachricht: erst lokal (sofort sichtbar), dann senden
  async function send(partner, text, myName) {
    text = String(text || '').trim();
    if (!text || !partner) return null;
    var c = cfg();
    var r = room(c.code, partner);
    var m = { from: c.code, fromName: myName || c.code, text: text, ts: Date.now(), cid: newId(), st: 'sending' };
    var msgs = load(r); msgs.push(m); save(r, msgs);
    return m; // Aufrufer rendert, ruft danach transmitNow(m)
  }
  async function transmitNow(partner, m, myName) { return transmit(partner, m, myName); }

  // Alle fehlgeschlagenen (nicht dauerhaft abgelehnten) Nachrichten dieses Chats erneut senden
  async function retry(partner, myName, includePerm) {
    var c = cfg(); var r = room(c.code, partner);
    var todo = load(r).filter(function (m) {
      return m.from === c.code && (m.st === 'failed' || m.st === 'sending') && (includePerm || !m.perm);
    });
    // 'sending' nur wenn älter als 20 s (Seite wurde währenddessen geschlossen)
    todo = todo.filter(function (m) { return m.st === 'failed' || Date.now() - m.ts > 20000; });
    var n = 0;
    for (var i = 0; i < todo.length; i++) { if (await transmit(partner, todo[i], myName) === 'sent') n++; }
    return n;
  }
  async function retryOne(partner, cid, myName) {
    var c = cfg(); var r = room(c.code, partner);
    var m = load(r).filter(function (x) { return x.cid === cid; })[0];
    if (!m) return 'failed';
    patchMsg(r, cid, { st: 'sending', perm: false, err: null });
    return transmit(partner, m, myName);
  }

  async function ack(code, token, ids) {
    if (!ids.length) return;
    try {
      await timeoutFetch(cfg().api + '/messages/' + encodeURIComponent(code) + '/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, ids: ids })
      }, 10000);
    } catch (e) { /* nächster Abruf liefert sie erneut, Dedupe über sid */ }
  }

  // Zeilen vom Server lokal speichern (dedupe über sid) und erst danach bestätigen.
  async function ingest(c, rows) {
    var out = {};
    var ackIds = [];
    var byRoom = {};
    rows.forEach(function (m) {
      ackIds.push(m.id);
      var r = room(c.code, m.sender_code);
      if (!byRoom[r]) byRoom[r] = { msgs: load(r), partner: m.sender_code };
      var list = byRoom[r].msgs;
      if (list.some(function (e) { return e.sid === m.id && e.from === m.sender_code; })) return;
      list.push({ from: m.sender_code, fromName: m.sender_name, text: m.message,
                  ts: new Date(m.created_at).getTime(), sid: m.id });
      out[m.sender_code] = (out[m.sender_code] || 0) + 1;
    });
    var allSaved = true;
    Object.keys(byRoom).forEach(function (r) {
      byRoom[r].msgs.sort(function (a, b) { return a.ts - b.ts; });
      if (!save(r, byRoom[r].msgs)) allSaved = false;
    });
    // Nur bestätigen, wenn lokal wirklich gespeichert → sonst bleibt sie beim Server
    if (allSaved) await ack(c.code, c.token, ackIds);
    else out = {};
    return out;
  }

  // Alle neuen Chat-Nachrichten holen, lokal speichern, bestätigen.
  // Rückgabe: { added: { partnerCode: anzahlNeu }, ok: bool }
  async function pull() {
    var c = cfg();
    var out = { added: {}, ok: false };
    if (pulling || !c.code || c.code === '000000' || !c.token) return out;
    pulling = true;
    try {
      var res = await timeoutFetch(c.api + '/messages/' + encodeURIComponent(c.code) +
        '?spot_type=caching_chat', { headers: { 'x-spotme-token': c.token } }, 12000);
      if (!res.ok) return out;
      var rows = await res.json();
      if (!Array.isArray(rows)) return out;
      out.added = await ingest(c, rows);
      out.ok = true;
      return out;
    } catch (e) { return out; }
    finally { pulling = false; }
  }

  // Ein Abruf für alles (Chat + Favoriten-Zähler + Hinweis-Postfach + Einstellungen).
  // status 404 = Server kennt /poll noch nicht → Aufrufer nimmt den alten Weg.
  async function pollAll() {
    var c = cfg();
    var out = { ok: false, added: {}, inbox: [], favorites: 0, silent: false, prefs: null, status: 0 };
    if (pulling || !c.code || c.code === '000000' || !c.token) return out;
    pulling = true;
    try {
      var res = await timeoutFetch(c.api + '/poll?code=' + encodeURIComponent(c.code) +
        '&token=' + encodeURIComponent(c.token), {}, 12000);
      out.status = res.status;
      if (!res.ok) return out;
      var d = await res.json();
      out.added = await ingest(c, Array.isArray(d.messages) ? d.messages : []);
      out.inbox = Array.isArray(d.inbox) ? d.inbox : [];
      out.favorites = d.favorites | 0;
      out.silent = !!d.silent;
      out.prefs = d.prefs || null;
      out.ok = true;
      return out;
    } catch (e) { return out; }
    finally { pulling = false; }
  }

  // Zähler für Favoriten-Hinweise (spot_type=favorite_checkin), ohne zu verbrauchen
  async function peekType(type) {
    var c = cfg();
    if (!c.code || c.code === '000000' || !c.token) return [];
    try {
      var res = await timeoutFetch(c.api + '/messages/' + encodeURIComponent(c.code) +
        '?spot_type=' + encodeURIComponent(type), { headers: { 'x-spotme-token': c.token } }, 12000);
      if (!res.ok) return [];
      var rows = await res.json();
      return Array.isArray(rows) ? rows : [];
    } catch (e) { return []; }
  }
  async function ackType(type) {
    var rows = await peekType(type);
    var c = cfg();
    await ack(c.code, c.token, rows.map(function (m) { return m.id; }));
  }

  window.SMChat = {
    PREFIX: PREFIX, room: room, load: load, save: save,
    send: send, transmit: transmitNow, retry: retry, retryOne: retryOne,
    pull: pull, pollAll: pollAll, ack: ack, peekType: peekType, ackType: ackType
  };
})();
