// live-events-client.js – Oberfläche für Live Spots als Event (Anmeldung / Check-in)
// Wird von live-spot.html (Besucher) und live-spot-manage.html (Veranstalter) geladen.
// Nutzt die dortigen Konstanten API, CODE, TOK.
(function () {
  "use strict";

  var RADIUS_PREFILTER_M = 150; // grobe Vorprüfung im Browser; entscheidet der Server (100 m)
  var state = { spot: null, me: null, online: false };
  var watchId = null;
  var lastTry = 0;

  // ── Helfer ────────────────────────────────────────────────────────────────
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function say(msg) {
    try {
      if (typeof showToast === "function") return showToast(msg);
      if (typeof toast === "function") return toast(msg);
    } catch (e) {}
    alert(msg);
  }
  function time(iso) {
    try {
      return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  function day(iso) {
    try {
      return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
    } catch (e) { return ""; }
  }
  function authBody(extra) {
    var b = { code: CODE, token: TOK };
    for (var k in extra || {}) b[k] = extra[k];
    return JSON.stringify(b);
  }
  function qs() {
    return "code=" + encodeURIComponent(CODE) + "&token=" + encodeURIComponent(TOK);
  }
  function distM(lat1, lng1, lat2, lng2) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function injectCss() {
    if (document.getElementById("leCss")) return;
    var st = document.createElement("style");
    st.id = "leCss";
    st.textContent =
      ".le-box{background:var(--card,#111827);border:1px solid var(--bord,#1f2937);border-radius:14px;padding:.9rem 1rem;margin-top:.75rem}" +
      ".le-head{font-family:'Space Mono',monospace;font-size:.6rem;font-weight:700;color:var(--muted,#6b7280);letter-spacing:.1em;margin-bottom:.4rem}" +
      ".le-count{font-size:1.05rem;font-weight:700;color:var(--text,#f5f1ea)}" +
      ".le-bar{height:6px;border-radius:99px;background:rgba(255,255,255,.08);margin:.5rem 0 .65rem;overflow:hidden}" +
      ".le-bar>i{display:block;height:100%;background:var(--acc,#f59e0b)}" +
      ".le-btn{width:100%;padding:.8rem;border-radius:13px;border:none;font-family:'Outfit',sans-serif;font-size:.9rem;font-weight:700;cursor:pointer;margin-top:.5rem;background:var(--acc,#f59e0b);color:#080b10}" +
      ".le-btn.ghost{background:transparent;border:1px solid var(--bord2,#374151);color:var(--text,#f5f1ea)}" +
      ".le-btn:disabled{opacity:.5;cursor:not-allowed}" +
      ".le-ok{color:var(--green,#00e676);font-weight:700}" +
      ".le-hint{font-size:.74rem;color:var(--muted2,#9ca3af);margin-top:.45rem;line-height:1.45}" +
      ".le-hint a{color:var(--acc,#f59e0b)}" +
      ".le-p{display:flex;align-items:center;gap:.5rem;padding:.45rem 0;border-bottom:1px solid var(--bord,#1f2937);font-size:.85rem}" +
      ".le-p:last-child{border-bottom:none}" +
      ".le-p .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".le-meta{font-size:.7rem;color:var(--muted2,#9ca3af)}" +
      ".le-x{background:none;border:1px solid var(--bord2,#374151);color:var(--muted2,#9ca3af);border-radius:8px;width:28px;height:28px;cursor:pointer}" +
      ".le-sub{font-weight:700;font-size:.82rem;margin:.2rem 0 .35rem}" +
      ".le-chips{display:flex;flex-wrap:wrap;gap:.35rem}" +
      ".le-chip{font-size:.75rem;padding:.2rem .6rem;border-radius:99px;background:var(--card2,#1a2230);border:1px solid var(--bord,#1f2937)}";
    document.head.appendChild(st);
  }

  // ── Besucher-Seite (live-spot.html) ────────────────────────────────────────
  function loadMe(spotId) {
    if (!CODE) return Promise.resolve(null);
    return fetch(API + "/live-spots/" + spotId + "/me?" + qs())
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function ticketHTML(spot, me, online) {
    injectCss();
    var max = spot.max_participants, n = spot.participant_count | 0;
    var head = max ? n + " / " + max + " Plätze belegt" : n + " angemeldet";
    var bar = max ? '<div class="le-bar"><i style="width:' + Math.min(100, Math.round((n / max) * 100)) + '%"></i></div>' : "";
    var action = "";
    if (!CODE) {
      action = '<div class="le-hint"><a href="/">App öffnen</a>, um dich anzumelden.</div>';
    } else if (me && me.is_owner) {
      action = '<div class="le-hint">Du bist der Veranstalter. <a href="live-spot-manage.html">Teilnehmer verwalten</a></div>';
    } else if (me && me.registered && me.checked_in) {
      action = '<div class="le-ok">✅ Eingecheckt um ' + esc(time(me.checked_in_at)) + '</div>' +
        '<button class="le-btn ghost" onclick="LiveEvents.unregister(' + spot.id + ')">Abmelden</button>';
    } else if (me && me.registered) {
      action = '<div class="le-ok">🎟️ Du bist angemeldet</div>' +
        (online
          ? '<button class="le-btn" id="leCheckBtn" onclick="LiveEvents.checkinNow(' + spot.id + ')">📍 Ich bin da – einchecken</button>' +
            '<div class="le-hint">Der Check-in erfolgt automatisch, sobald du dich in der Nähe (ca. 100 m) befindest und diese Seite geöffnet ist.</div>'
          : '<div class="le-hint">Der Check-in startet, sobald der Live Spot online ist.</div>') +
        '<button class="le-btn ghost" onclick="LiveEvents.unregister(' + spot.id + ')">Abmelden</button>';
    } else {
      action = '<button class="le-btn" id="leRegBtn" onclick="LiveEvents.register(' + spot.id + ')">🎟️ Anmelden</button>';
    }
    return '<div class="le-box" id="leTicket"><div class="le-head">🎟️ TEILNAHME</div>' +
      '<div class="le-count">' + head + '</div>' + bar + action + '</div>';
  }

  function render() {
    var el = document.getElementById("leTicket");
    if (!el || !state.spot) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = ticketHTML(state.spot, state.me, state.online);
    el.replaceWith(tmp.firstChild);
  }

  function stopWatch() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function startWatch() {
    if (watchId !== null || !navigator.geolocation) return;
    var s = state.spot;
    watchId = navigator.geolocation.watchPosition(
      function (pos) {
        if (!state.me || !state.me.registered || state.me.checked_in) return stopWatch();
        if (Date.now() - lastTry < 15000) return;
        var d = distM(pos.coords.latitude, pos.coords.longitude, +s.lat, +s.lng);
        if (d > RADIUS_PREFILTER_M) return;
        lastTry = Date.now();
        postCheckin(s.id, pos.coords.latitude, pos.coords.longitude, true);
      },
      function () {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    window.addEventListener("pagehide", stopWatch);
  }

  function initTicket(spot, me, online) {
    state = { spot: spot, me: me, online: !!online };
    if (me && me.registered && !me.checked_in && online && spot.lat != null) startWatch();
  }

  function postCheckin(spotId, lat, lng, silent) {
    return fetch(API + "/live-spots/" + spotId + "/checkin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: authBody({ lat: lat, lng: lng })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (x.ok) {
          state.me.checked_in = true;
          state.me.checked_in_at = x.j.checked_in_at;
          stopWatch();
          render();
          say("✅ Eingecheckt!");
        } else if (!silent) {
          say("⚠️ " + (x.j.error || "Check-in nicht möglich"));
        }
      })
      .catch(function () { if (!silent) say("⚠️ Verbindungsfehler"); });
  }

  function checkinNow(spotId) {
    if (!navigator.geolocation) return say("⚠️ Standort nicht verfügbar");
    var btn = document.getElementById("leCheckBtn");
    if (btn) btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        postCheckin(spotId, pos.coords.latitude, pos.coords.longitude, false).then(function () {
          var b = document.getElementById("leCheckBtn"); if (b) b.disabled = false;
        });
      },
      function () { say("⚠️ Standort nicht verfügbar"); if (btn) btn.disabled = false; },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  function register(spotId) {
    var btn = document.getElementById("leRegBtn");
    if (btn) btn.disabled = true;
    fetch(API + "/live-spots/" + spotId + "/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: authBody()
    }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (x) {
        if (x.s === 200) {
          state.me = { registered: true, checked_in: false, is_owner: false };
          state.spot.participant_count = x.j.participant_count;
          render();
          say("🎟️ Angemeldet!");
          if (state.online && state.spot.lat != null) startWatch();
        } else if (x.s === 404) {
          say("Leider ausgebucht – dieser Live Spot ist nicht mehr verfügbar.");
          setTimeout(function () { location.reload(); }, 1800);
        } else {
          say("⚠️ " + (x.j.error || "Anmeldung nicht möglich"));
          if (btn) btn.disabled = false;
        }
      })
      .catch(function () { say("⚠️ Verbindungsfehler"); if (btn) btn.disabled = false; });
  }

  function unregister(spotId) {
    if (!confirm("Wirklich abmelden? Dein Platz wird freigegeben.")) return;
    fetch(API + "/live-spots/" + spotId + "/register", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: authBody()
    }).then(function (r) {
      if (!r.ok) return say("⚠️ Abmelden fehlgeschlagen");
      stopWatch();
      state.me = { registered: false, checked_in: false, is_owner: false };
      state.spot.participant_count = Math.max(0, (state.spot.participant_count | 0) - 1);
      render();
      say("Abgemeldet");
    }).catch(function () { say("⚠️ Verbindungsfehler"); });
  }

  // ── Veranstalter-Seite (live-spot-manage.html) ─────────────────────────────
  function capacityField(s) {
    return '<span class="finp-label">Max. Teilnehmer (leer = unbegrenzt)</span>' +
      '<input class="finp" id="lsMax" type="number" min="1" max="100000" inputmode="numeric" ' +
      'placeholder="z. B. 20 – leer lassen für unbegrenzt" value="' + (s && s.max_participants ? s.max_participants : "") + '">' +
      '<div class="le-hint">Ist das Limit erreicht, ist der Live Spot für alle ausgeblendet, die nicht angemeldet sind.</div>';
  }

  function readCapacity() {
    var el = document.getElementById("lsMax");
    var v = el ? String(el.value).trim() : "";
    if (v === "") return { value: null };
    if (!/^\d+$/.test(v) || +v < 1 || +v > 100000)
      return { error: "Max. Teilnehmer: ganze Zahl ab 1 (oder leer für unbegrenzt)" };
    return { value: +v };
  }

  function peopleHTML(s) {
    injectCss();
    return '<div class="section"><div class="section-head">TEILNEHMER &amp; FOLLOWER</div>' +
      '<div class="section-body" id="lePeople" data-spot="' + s.id + '">Lade …</div></div>';
  }

  function loadPeople(spotId) {
    var box = document.getElementById("lePeople");
    if (!box) return;
    Promise.all([
      fetch(API + "/live-spots/" + spotId + "/participants?" + qs()).then(function (r) { return r.ok ? r.json() : null; }),
      fetch(API + "/live-spots/" + spotId + "/followers?" + qs()).then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (res) {
      var p = res[0], f = res[1];
      if (!document.getElementById("lePeople")) return;
      if (!p) { box.textContent = "Liste konnte nicht geladen werden."; return; }
      var head = (p.max_participants ? p.participant_count + " / " + p.max_participants : p.participant_count + " angemeldet") +
        " · " + p.checked_in_count + " eingecheckt";
      var rows = p.participants.map(function (x) {
        var st = x.checked_in_at
          ? '<span class="le-ok">✓ ' + esc(time(x.checked_in_at)) + "</span>"
          : '<span class="le-meta">angemeldet ' + esc(day(x.registered_at)) + "</span>";
        return '<div class="le-p"><span class="n">' + esc(x.name) + "</span>" + st +
          '<button class="le-x" title="Entfernen" onclick="LiveEvents.kick(' + spotId + "," + x.id + ')">✕</button></div>';
      }).join("");
      var html = '<div class="le-sub">Teilnehmer · ' + head + "</div>" +
        (rows || '<div class="le-hint">Noch niemand angemeldet.</div>') +
        (p.participant_count
          ? '<button class="btn btn-ghost" onclick="LiveEvents.resetList(' + spotId + ')">🔄 Neue Runde (Liste leeren)</button>'
          : "");
      if (f) {
        html += '<div class="le-sub" style="margin-top:1rem">Follower · ' + f.follower_count + "</div>" +
          (f.followers.length
            ? '<div class="le-chips">' + f.followers.map(function (x) { return '<span class="le-chip">' + esc(x.name) + "</span>"; }).join("") + "</div>"
            : '<div class="le-hint">Noch keine Follower.</div>');
      }
      box.innerHTML = html;
    }).catch(function () { box.textContent = "Verbindungsfehler"; });
  }

  function kick(spotId, pid) {
    if (!confirm("Teilnehmer entfernen? Der Platz wird frei.")) return;
    fetch(API + "/live-spots/" + spotId + "/participants/" + pid, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: authBody()
    }).then(function (r) {
      if (!r.ok) return say("⚠️ Entfernen fehlgeschlagen");
      say("Teilnehmer entfernt");
      loadPeople(spotId);
    }).catch(function () { say("⚠️ Verbindungsfehler"); });
  }

  function resetList(spotId) {
    if (!confirm("Alle Anmeldungen und Check-ins löschen (neue Runde)?")) return;
    fetch(API + "/live-spots/" + spotId + "/participants/reset", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: authBody()
    }).then(function (r) {
      if (!r.ok) return say("⚠️ Fehlgeschlagen");
      say("Liste geleert");
      loadPeople(spotId);
    }).catch(function () { say("⚠️ Verbindungsfehler"); });
  }

  window.LiveEvents = {
    loadMe: loadMe, ticketHTML: ticketHTML, initTicket: initTicket,
    register: register, unregister: unregister, checkinNow: checkinNow,
    capacityField: capacityField, readCapacity: readCapacity,
    peopleHTML: peopleHTML, loadPeople: loadPeople, kick: kick, resetList: resetList
  };
})();
