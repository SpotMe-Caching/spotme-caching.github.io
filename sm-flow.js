/* SpotMe Flow – "zurück zur letzten Seite" statt alles schließen.
 *
 * SMFlow.go(url)       → Seite öffnen, aktuelle Seite als Rückweg merken
 * SMFlow.back(fallback)→ zur zuletzt besuchten Seite (✕-Button), sonst fallback (Standard: Karte)
 *
 * Der Rückweg-Stapel liegt in sessionStorage (pro App/Tab, wird beim Schließen verworfen).
 * Benutzt der Nutzer die System-Zurück-Taste, räumt sync() den Stapel beim Laden auf.
 */
(function () {
  'use strict';
  var KEY = 'sm_flow_stack', MAX = 12;
  function here() { return (location.pathname.split('/').pop() || 'index.html') + location.search + location.hash; }
  function page(u) { return String(u).split('#')[0].split('?')[0].split('/').pop() || 'index.html'; }
  function read() { try { var v = JSON.parse(sessionStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function write(a) { try { sessionStorage.setItem(KEY, JSON.stringify(a.slice(-MAX))); } catch (e) {} }

  // Beim Laden: steht die aktuelle Seite oben im Stapel (System-Zurück genutzt) → entfernen
  function sync() {
    var s = read(), p = page(here());
    while (s.length && page(s[s.length - 1]) === p) s.pop();
    write(s);
  }

  function go(url) {
    var s = read(), h = here();
    if (!s.length || s[s.length - 1] !== h) s.push(h);
    write(s);
    location.href = url;
  }

  function back(fallback) {
    var s = read(), p = page(here()), target = null;
    while (s.length) { var t = s.pop(); if (page(t) !== p) { target = t; break; } }
    write(s);
    location.href = target || fallback || 'index.html';
  }

  sync();
  window.SMFlow = { go: go, back: back, sync: sync, peek: function () { var s = read(); return s[s.length - 1] || null; } };
})();
