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
  function fmtWhen(iso) {
    try {
      return new Date(iso).toLocaleString("de-DE", {
        weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
      }) + " Uhr";
    } catch (e) { return ""; }
  }
  function gcalUrl(spot) {
    var s = new Date(spot.starts_at), e = new Date(s.getTime() + 2 * 3600000);
    var f = function (d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); };
    return "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" + encodeURIComponent(spot.name) +
      "&dates=" + f(s) + "/" + f(e) +
      "&location=" + encodeURIComponent(spot.location_note || "") +
      "&details=" + encodeURIComponent(location.origin + "/live-spot.html?id=" + spot.id);
  }
  // Check-in möglich? live, oder geplant und höchstens 30 Min vor Start
  function canCheckin(spot) {
    if (spot.status === "online") return true;
    return spot.status === "planned" && !!spot.starts_at &&
      new Date(spot.starts_at).getTime() - Date.now() <= 30 * 60000;
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
      ".le-when{font-weight:700;color:var(--acc,#f59e0b);margin-bottom:.2rem}" +
      ".le-hint{font-size:.74rem;color:var(--muted2,#9ca3af);margin-top:.45rem;line-height:1.45}" +
      ".le-hint a{color:var(--acc,#f59e0b)}" +
      ".le-p{display:flex;align-items:center;gap:.5rem;padding:.45rem 0;border-bottom:1px solid var(--bord,#1f2937);font-size:.85rem}" +
      ".le-p:last-child{border-bottom:none}" +
      ".le-p .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".le-meta{font-size:.7rem;color:var(--muted2,#9ca3af)}" +
      ".le-x{background:none;border:1px solid var(--bord2,#374151);color:var(--muted2,#9ca3af);border-radius:8px;width:28px;height:28px;cursor:pointer}" +
      ".le-sub{font-weight:700;font-size:.82rem;margin:.2rem 0 .35rem}" +
      ".le-chips{display:flex;flex-wrap:wrap;gap:.35rem}" +
      ".le-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.4rem;margin-top:.5rem}" +
      ".le-th{position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:var(--card2,#1a2230);border:1px solid var(--bord,#1f2937)}" +
      ".le-th img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}" +
      ".le-th .st{position:absolute;left:4px;top:4px;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:99px;background:rgba(0,0,0,.7);color:#fff}" +
      ".le-th .acts{position:absolute;right:3px;bottom:3px;display:flex;gap:3px}" +
      ".le-th .acts button{width:26px;height:26px;border-radius:7px;border:none;background:rgba(0,0,0,.7);color:#fff;font-size:.8rem;cursor:pointer}" +
      ".le-cap{position:absolute;left:0;right:0;bottom:0;padding:2px 5px;font-size:.62rem;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.75));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
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
          : '<div class="le-hint">' + (spot.status === "planned"
              ? "Der Check-in startet 30 Minuten vor Beginn."
              : "Der Check-in startet, sobald der Live Spot online ist.") + '</div>') +
        '<button class="le-btn ghost" onclick="LiveEvents.unregister(' + spot.id + ')">Abmelden</button>';
    } else {
      action = '<button class="le-btn" id="leRegBtn" onclick="LiveEvents.register(' + spot.id + ')">🎟️ Anmelden</button>';
    }
    var when = "";
    if (spot.status === "planned" && spot.starts_at) {
      when = '<div class="le-when">📅 ' + esc(fmtWhen(spot.starts_at)) + '</div>' +
        '<div class="le-hint" style="margin:0 0 .5rem"><a href="' + esc(gcalUrl(spot)) + '" target="_blank" rel="noopener">In Kalender eintragen</a>' +
        ' · <a href="' + esc(API + "/live-spots/" + spot.id + "/ics" + (CODE ? "?" + qs() : "")) + '">.ics</a></div>';
    }
    return '<div class="le-box" id="leTicket"><div class="le-head">🎟️ TEILNAHME</div>' + when +
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
    if (me && me.registered && !me.checked_in && online && spot.lat != null && !spot.location_hidden) startWatch();
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
          // Seite lädt den Spot jetzt mit Zugangsdaten neu → echter Standort
          if (typeof window.onLiveEventChange === "function") window.onLiveEventChange();
          else if (state.online && state.spot.lat != null && !state.spot.location_hidden) startWatch();
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
      if (typeof window.onLiveEventChange === "function") window.onLiveEventChange();
    }).catch(function () { say("⚠️ Verbindungsfehler"); });
  }

  // ── Veranstalter-Seite (live-spot-manage.html) ─────────────────────────────
  function capacityField(s) {
    return '<span class="finp-label">Max. Teilnehmer (leer = unbegrenzt)</span>' +
      '<input class="finp" id="lsMax" type="number" min="1" max="100000" inputmode="numeric" ' +
      'placeholder="z. B. 20 – leer lassen für unbegrenzt" value="' + (s && s.max_participants ? s.max_participants : "") + '">' +
      '<div class="le-hint">Ist das Limit erreicht, ist der Live Spot für alle ausgeblendet, die nicht angemeldet sind.</div>' +
      '<label style="display:flex;gap:0.5rem;align-items:flex-start;margin-top:0.75rem;font-size:0.85rem;cursor:pointer;">' +
      '<input type="checkbox" id="lsHide" style="margin-top:0.2rem;width:18px;height:18px;flex-shrink:0;"' +
      (!s || s.hide_location !== false ? " checked" : "") + '>' +
      '<span>🔒 Genauen Standort erst nach Anmeldung zeigen</span></label>' +
      '<div class="le-hint">Wer nicht angemeldet ist, sieht nur einen ungefähren Bereich (ca. 500 m) ohne Treffpunkt-Notiz. ' +
      'Das hält spontane, unangemeldete Besucher ein Stück weit fern – eine Garantie ist es nicht.</div>';
  }

  function readHideLocation() {
    var el = document.getElementById("lsHide");
    return el ? !!el.checked : true;
  }

  function readCapacity() {
    var el = document.getElementById("lsMax");
    var v = el ? String(el.value).trim() : "";
    if (v === "") return { value: null };
    if (!/^\d+$/.test(v) || +v < 1 || +v > 100000)
      return { error: "Max. Teilnehmer: ganze Zahl ab 1 (oder leer für unbegrenzt)" };
    return { value: +v };
  }

  // Ankündigung (Veranstalter): Datum + Treffpunkt (Karte/Notiz oben im Steuerungs-Bereich)
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function scheduleHTML(s) {
    injectCss();
    var planned = s.status === "planned" && s.starts_at;
    return '<div class="section"><div class="section-head">📅 TERMIN ANKÜNDIGEN</div><div class="section-body">' +
      (planned ? '<div class="le-when">Geplant: ' + esc(fmtWhen(s.starts_at)) + '</div>' : "") +
      '<span class="finp-label">Datum &amp; Uhrzeit</span>' +
      '<input class="finp" id="lsStart" type="datetime-local" value="' + esc(toLocalInput(s.starts_at)) + '">' +
      '<div class="le-hint">Treffpunkt: Karte oben antippen, Notiz oben eintragen. ' +
      'Angemeldet wird schon vorab; der Check-in öffnet 30 Minuten vor Beginn. Live gehst du selbst mit „Jetzt live gehen".</div>' +
      '<button class="btn btn-save" onclick="LiveEvents.saveSchedule(' + s.id + ')">📅 ' + (planned ? "Termin ändern" : "Termin ankündigen") + '</button>' +
      (planned ? '<button class="btn btn-danger" onclick="LiveEvents.cancelEvent(' + s.id + ')">✕ Termin absagen</button>' : "") +
      '</div></div>';
  }
  function reloadManage(id) {
    return loadMySpots().then(function () {
      activeSpot = mySpots.find(function (x) { return x.id === id; }) || null;
      renderPage();
      if (activeSpot) setTimeout(function () { initLiveMap(activeSpot.lat, activeSpot.lng); }, 80);
    });
  }
  function saveSchedule(id) {
    var v = (document.getElementById("lsStart") || {}).value;
    if (!v) return say("⚠️ Bitte Datum und Uhrzeit wählen");
    var when = new Date(v);
    if (isNaN(when.getTime())) return say("⚠️ Ungültiges Datum");
    var place = (typeof tapCoords !== "undefined" && tapCoords) ? tapCoords
      : (activeSpot && activeSpot.lat != null ? { lat: activeSpot.lat, lng: activeSpot.lng } : null);
    if (!place) return say("⚠️ Bitte den Treffpunkt auf der Karte antippen");
    var note = ((document.getElementById("locationNote") || {}).value || "").trim();
    fetch(API + "/live-spots/" + id, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: authBody({ name: activeSpot.name, description: activeSpot.description, category: activeSpot.category,
        avatar: activeSpot.avatar, starts_at: when.toISOString(), lat: place.lat, lng: place.lng, location_note: note })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) return say("❌ " + (x.j.error || "Fehler"));
        say("📅 Termin gespeichert");
        return reloadManage(id);
      }).catch(function () { say("⚠️ Verbindungsfehler"); });
  }
  function cancelEvent(id) {
    if (!confirm("Termin absagen? Alle Anmeldungen werden gelöscht.")) return;
    fetch(API + "/live-spots/" + id + "/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: authBody()
    }).then(function (r) {
      if (!r.ok) return say("⚠️ Absagen fehlgeschlagen");
      say("Termin abgesagt");
      return reloadManage(id);
    }).catch(function () { say("⚠️ Verbindungsfehler"); });
  }

  // ── Event-Bilder ───────────────────────────────────────────────────────────
  var MAX_IMAGES = 12;
  function rawUrl(spotId, imgId) { return API + "/live-spots/" + spotId + "/images/" + imgId + "/raw"; }

  // Bild im Browser verkleinern (max. 1280 px, JPEG) – spart Datenbank und Ladezeit
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1280, k = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var q = 0.82, out = c.toDataURL("image/jpeg", q);
        while (out.length > 900000 && q > 0.4) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
        resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Bild nicht lesbar")); };
      img.src = url;
    });
  }

  function imagesHTML(s) {
    injectCss();
    return '<div class="section"><div class="section-head">🖼️ BILDER ZUM EVENT</div>' +
      '<div class="section-body" id="leImages" data-spot="' + s.id + '">Lade …</div></div>';
  }

  function loadImages(spotId) {
    var box = document.getElementById("leImages");
    if (!box) return;
    fetch(API + "/live-spots/" + spotId + "/images?" + qs())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!document.getElementById("leImages")) return;
        if (!d) { box.textContent = "Bilder konnten nicht geladen werden."; return; }
        var n = d.images.length;
        var grid = d.images.map(function (im) {
          var ok = im.status === "approved";
          return '<div class="le-th"><img src="' + esc(im.image) + '" alt="" onclick="openImg(this.src)">' +
            '<span class="st">' + (ok ? "✅ sichtbar" : "⏳ Prüfung") + '</span>' +
            (im.caption ? '<div class="le-cap">' + esc(im.caption) + '</div>' : '') +
            '<div class="acts"><button title="Beschriftung" onclick="LiveEvents.captionImage(' + spotId + "," + im.id + ')">✏️</button>' +
            '<button title="Löschen" onclick="LiveEvents.deleteImage(' + spotId + "," + im.id + ')">🗑️</button></div></div>';
        }).join("");
        box.innerHTML =
          '<div class="le-hint" style="margin:0 0 .4rem">Alle sehen freigegebene Bilder auf der Live-Spot-Seite. Neue Bilder prüfen wir kurz, bevor sie erscheinen. Sie bleiben, bis du sie löschst.</div>' +
          '<div class="le-sub">' + n + " / " + MAX_IMAGES + " Bilder</div>" +
          (n ? '<div class="le-grid">' + grid + "</div>" : "") +
          (n < MAX_IMAGES
            ? '<input type="file" id="leFile" accept="image/jpeg,image/png,image/webp" multiple style="display:none" onchange="LiveEvents.uploadImages(' + spotId + ', this.files)">' +
              '<button class="btn btn-ghost" id="leUpBtn" onclick="document.getElementById(\'leFile\').click()">＋ Bilder hinzufügen</button>'
            : "");
      })
      .catch(function () { box.textContent = "Verbindungsfehler"; });
  }

  async function uploadImages(spotId, files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var btn = document.getElementById("leUpBtn"); if (btn) btn.disabled = true;
    var okN = 0, last = "";
    for (var i = 0; i < list.length; i++) {
      if (btn) btn.textContent = "⏳ " + (i + 1) + " / " + list.length;
      try {
        var data = await shrink(list[i]);
        var r = await fetch(API + "/live-spots/" + spotId + "/images", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: authBody({ image: data })
        });
        if (r.ok) okN++;
        else { var e = await r.json().catch(function () { return {}; }); last = e.error || "Fehler"; if (r.status === 400 && /Maximal/.test(last)) break; }
      } catch (e) { last = e.message || "Fehler"; }
    }
    say(okN ? "🖼️ " + okN + " Bild(er) hochgeladen – in Prüfung" + (last ? " · " + last : "") : "❌ " + (last || "Upload fehlgeschlagen"));
    loadImages(spotId);
  }

  function captionImage(spotId, imgId) {
    var t = prompt("Beschriftung (max. 100 Zeichen, leer = keine):", "");
    if (t === null) return;
    fetch(API + "/live-spots/" + spotId + "/images/" + imgId, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: authBody({ caption: t })
    }).then(function (r) { say(r.ok ? "Gespeichert" : "⚠️ Fehlgeschlagen"); loadImages(spotId); })
      .catch(function () { say("⚠️ Verbindungsfehler"); });
  }

  function deleteImage(spotId, imgId) {
    if (!confirm("Dieses Bild löschen?")) return;
    fetch(API + "/live-spots/" + spotId + "/images/" + imgId, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: authBody()
    }).then(function (r) { say(r.ok ? "Bild gelöscht" : "⚠️ Fehlgeschlagen"); loadImages(spotId); })
      .catch(function () { say("⚠️ Verbindungsfehler"); });
  }

  // Galerie auf der Live-Spot-Seite (alle sehen freigegebene Bilder)
  function loadGallery(spotId) {
    var box = document.getElementById("leGallery");
    if (!box) return;
    var q = CODE ? "?" + qs() : "";
    fetch(API + "/live-spots/" + spotId + "/images" + q)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var ims = d.images.filter(function (x) { return x.status === "approved"; });
        if (!ims.length) { box.innerHTML = ""; return; }
        injectCss();
        box.innerHTML = '<div class="le-box"><div class="le-head">🖼️ BILDER</div><div class="le-grid">' +
          ims.map(function (im) {
            return '<div class="le-th"><img loading="lazy" alt="" src="' + esc(rawUrl(spotId, im.id)) + '" onclick="openImg(this.src)">' +
              (im.caption ? '<div class="le-cap">' + esc(im.caption) + "</div>" : "") + "</div>";
          }).join("") + "</div></div>";
      }).catch(function () {});
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

  // Fallback-Vollbild (Verwaltungsseite hat kein eigenes)
  if (typeof window.openImg !== "function") {
    window.openImg = function (src) {
      var o = document.createElement("div");
      o.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;cursor:zoom-out";
      var i = document.createElement("img"); i.src = src; i.style.cssText = "max-width:96%;max-height:96%;border-radius:8px";
      o.appendChild(i); o.onclick = function () { o.remove(); }; document.body.appendChild(o);
    };
  }

  window.LiveEvents = {
    loadMe: loadMe, ticketHTML: ticketHTML, initTicket: initTicket,
    register: register, unregister: unregister, checkinNow: checkinNow,
    capacityField: capacityField, readCapacity: readCapacity, readHideLocation: readHideLocation,
    scheduleHTML: scheduleHTML, saveSchedule: saveSchedule, cancelEvent: cancelEvent,
    canCheckin: canCheckin, fmtWhen: fmtWhen,
    imagesHTML: imagesHTML, loadImages: loadImages, uploadImages: uploadImages,
    captionImage: captionImage, deleteImage: deleteImage, loadGallery: loadGallery,
    peopleHTML: peopleHTML, loadPeople: loadPeople, kick: kick, resetList: resetList
  };
})();
