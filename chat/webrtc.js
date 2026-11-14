// ════════════════════════════════════════════════════════════════════════════
// SPOTME CHAT · WebRTC Integration (PeerJS) - V2.1 FIX (ID Collision)
// ════════════════════════════════════════════════════════════════════════════

window.SpotMeWebRTC = class SpotMeWebRTC {
  constructor(code, token, userName = null) {
    this.code = code;
    this.token = token;
    this.userName = userName || code;
    this.peer = null;
    this.conn = null;
    this.room = null;
    this.peerReady = false;

    this.onMessage = null;
    this.onAck = null; // Zustellbestätigung (KEIN Lesestatus!)
    this.onConnect = null;
    this.onDisconnect = null;
    this.onError = null;
    this.onPeerReady = null;
    this.onImage = null; // komplettes Bild per P2P empfangen
    this._rx = {};      // laufende Bild-Empfänge je Partner

    this.reconnectAttempts = 0;
    this.MAX_RECONNECT = 5;
    this.isDestroyed = false; // Sicherheitsflag
    this._registering = false;
    this._lastRegister = 0;
    this.lastError = null; // nur zur Anzeige im Profil (Diagnose)
  }

  // Meldet den Peer nur an, wenn nicht schon einer läuft/angemeldet ist (kein Dauer-Neustart)
  ensureRegistered() {
    if (this.isDestroyed || this.peerReady || this._registering) return;
    if (Date.now() - this._lastRegister < 15000) return;
    this.register();
  }

  async register() {
    if (this._registering) return;
    this._registering = true;
    this._lastRegister = Date.now();
    // Hängt die Anmeldung (z. B. Netz weg), nach 20 s freigeben, damit ein neuer Versuch möglich ist
    setTimeout(() => { this._registering = false; }, 20000);
    console.log("[WebRTC] Registriere Peer mit ID:", this.code);
    this.isDestroyed = false;

    // Falls noch ein Peer existiert, hart zerstören
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch (e) {}
      this.peer = null;
    }

    // FIX: Vor der Peer-Registrierung ein kurzlebiges Ticket holen.
    // Ohne gültiges Ticket kappt der Server die Verbindung sofort wieder –
    // verhindert dass fremde die eigene Code-ID als Peer kapern.
    try {
      const ticketRes = await fetch(
        "https://spotme-chat-obom.onrender.com/api/peer-ticket",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: this.code, token: this.token }),
        },
      );
      if (!ticketRes.ok) {
        console.error("[WebRTC] Ticket-Anforderung fehlgeschlagen:", ticketRes.status);
        this.lastError = "ticket " + ticketRes.status;
        this._registering = false;
        return; // ensureRegistered() versucht es später erneut
      }
    } catch (e) {
      console.error("[WebRTC] Ticket-Anforderung fehlgeschlagen:", e);
      this.lastError = "ticket offline";
      this._registering = false;
      return;
    }

    if (this.isDestroyed) return; // Zwischenzeitlich zerstört (z.B. Logout)

    this.peer = new Peer(this.code, {
      debug: 2,
      host: "spotme-chat-obom.onrender.com",
      port: 443,
      path: "/peerjs",
      secure: true,
    });

    this.peer.on("open", (id) => {
      console.log("[WebRTC] Peer erfolgreich registriert, ID:", id);
      this.peerReady = true;
      this._registering = false;
      this.lastError = null;
      this.reconnectAttempts = 0;
      if (this.onPeerReady) this.onPeerReady(id);
    });

    this.peer.on("connection", (conn) => {
      console.log("[WebRTC] Eingehende Verbindung von:", conn.peer);
      this.handleConnection(conn);
    });

    // ── FEHLERBEHANDLUNG ──────────────────────────────────────────
    // Wichtig: Jede Anmeldung braucht ein frisches, einmaliges Ticket. Ein einfaches
    // peer.reconnect() hat keins und wird vom Server sofort gekappt → Dauerschleife.
    // Darum immer komplett neu anmelden (ensureRegistered), aber höchstens alle 15 s.
    const lost = () => {
      this.peerReady = false;
      this._registering = false;
      if (this.peer && !this.peer.destroyed) { try { this.peer.destroy(); } catch (e) {} }
      this.peer = null;
      setTimeout(() => this.ensureRegistered(), 3000);
    };

    this.peer.on("error", (err) => {
      console.error("[WebRTC] Peer Error:", err.type, err);
      this.lastError = err.type || "unbekannt";

      // ID noch vom alten Eintrag belegt → später neu
      if (err.type === "unavailable-id") { lost(); return; }

      // Signalserver weg / Socket zu → neu anmelden
      if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) { lost(); return; }

      // Partner (noch) nicht online: normal, kein Fehler
      if (err.type === "peer-unavailable") {
        if (this.onError) this.onError(err);
        return;
      }
      if (this.onError) this.onError(err);
    });

    this.peer.on("disconnected", () => {
      console.warn("[WebRTC] Peer disconnected vom Server");
      lost();
    });

    this.peer.on("close", () => {
      console.log("[WebRTC] Peer geschlossen");
      this.peerReady = false;
      this._registering = false;
    });
  }

  tryReconnect() {
    this._lastRegister = 0;
    this.ensureRegistered();
  }

  async waitForReady() {
    if (this.peerReady && this.peer && this.peer.id) {
      return this.peer.id;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Peer-Registrierung Timeout (10s)"));
      }, 10000);

      const checkInterval = setInterval(() => {
        if (this.peerReady && this.peer && this.peer.id) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(this.peer.id);
        }
      }, 200);
    });
  }

  async connect(partnerCode, onReady) {
    try {
      const peerId = await this.waitForReady();
      if (typeof onReady === "function") onReady(peerId);
      return peerId;
    } catch (err) {
      console.error("[WebRTC] Connect fehlgeschlagen:", err.message);
      throw err;
    }
  }

  handleConnection(conn) {
    if (this.conn && this.conn.peer === conn.peer && this.conn.open) {
      conn.close();
      return;
    }

    this.conn = conn;

    conn.on("open", () => {
      console.log("[WebRTC] Datenkanal geöffnet zu", conn.peer);
      if (this.onConnect) this.onConnect(conn.peer);
    });

    conn.on("data", (data) => {
      if (data && data.type === "IMG_START") { this._imgStart(conn, data); return; }
      if (data && data.type === "IMG_CHUNK") { this._imgChunk(conn, data); return; }
      if (this.onMessage && data.type === "MESSAGE") {
        this.onMessage({
          text: data.text,
          from: conn.peer,
          fromName: data.fromName,
          ts: data.ts || Date.now(),
        });
        // Sofort-Ack: bestätigt nur ZUSTELLUNG (Datenkanal offen, Nachricht
        // angekommen). KEIN Lesestatus, keine Uhrzeit-Info über "online" –
        // das würde Rückschlüsse auf die Anwesenheit des Partners erlauben.
        try {
          conn.send({ type: "ACK", ackTs: data.ts });
        } catch (e) {
          console.warn("[WebRTC] Ack konnte nicht gesendet werden:", e);
        }
        return;
      }
      if (this.onAck && data.type === "ACK") {
        this.onAck(conn.peer, data.ackTs);
      }
    });

    conn.on("close", () => {
      console.log("[WebRTC] Verbindung geschlossen zu", conn.peer);
      if (this.conn === conn) this.conn = null;
      if (this.onDisconnect) this.onDisconnect(conn.peer);
    });

    conn.on("error", (err) => {
      console.error("[WebRTC] Connection Error:", err);
      if (this.onError) this.onError(err);
    });
  }

  // ── Bilder: nur direkt per P2P, in Stücken, nie über den Server ──
  _imgStart(conn, d) {
    const ok = d && typeof d.id === "string" && d.id.length <= 40 &&
      Number.isInteger(d.n) && d.n >= 1 && d.n <= 60 &&
      d.mime === "image/jpeg" && Number.isFinite(d.ts);
    if (!ok) return;
    const prev = this._rx[conn.peer];
    if (prev && prev.timer) clearTimeout(prev.timer);
    const rx = { id: d.id, n: d.n, parts: [], bytes: 0, ts: d.ts, fromName: String(d.fromName || "").slice(0, 40) };
    rx.timer = setTimeout(() => { if (this._rx[conn.peer] === rx) delete this._rx[conn.peer]; }, 60000);
    this._rx[conn.peer] = rx;
  }

  _imgChunk(conn, d) {
    const rx = this._rx[conn.peer];
    if (!rx || !d || d.id !== rx.id || d.i !== rx.parts.length || typeof d.d !== "string" || d.d.length > 40000) return;
    rx.bytes += d.d.length;
    if (rx.bytes > 2200000) { clearTimeout(rx.timer); delete this._rx[conn.peer]; return; }
    rx.parts.push(d.d);
    if (rx.parts.length < rx.n) return;
    clearTimeout(rx.timer);
    delete this._rx[conn.peer];
    const b64 = rx.parts.join("");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return;
    if (this.onImage) {
      this.onImage({ id: rx.id, from: conn.peer, fromName: rx.fromName, ts: rx.ts, dataUrl: "data:image/jpeg;base64," + b64 });
    }
    try { conn.send({ type: "ACK", ackTs: rx.ts }); } catch (e) {}
  }

  async sendImage(dataUrl, ts, id) {
    const conn = this.conn;
    if (!conn || !conn.open) return false;
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl || "");
    if (!m) return false;
    const b64 = m[1], SIZE = 30000, n = Math.ceil(b64.length / SIZE);
    if (n > 60) return false;
    try {
      conn.send({ type: "IMG_START", id, n, mime: "image/jpeg", ts, fromName: this.userName });
      for (let i = 0; i < n; i++) {
        if (!conn.open) return false;
        // nicht schneller senden, als der Kanal abtransportiert
        let guard = 0;
        while (conn.dataChannel && conn.dataChannel.bufferedAmount > 512 * 1024 && guard++ < 200) {
          await new Promise((r) => setTimeout(r, 50));
        }
        conn.send({ type: "IMG_CHUNK", id, i, d: b64.slice(i * SIZE, (i + 1) * SIZE) });
      }
      return true;
    } catch (e) {
      console.warn("[WebRTC] Bild senden fehlgeschlagen:", e);
      return false;
    }
  }

  // Direkter Kanal genau zu diesem Partner offen?
  isConnectedTo(partnerCode) {
    return !!(this.conn && this.conn.open && this.conn.peer === partnerCode);
  }

  initiateConnection(partnerCode) {
    if (!this.peer || !this.peerReady) {
      console.error("[WebRTC] Peer nicht bereit für initiateConnection");
      return null;
    }

    if (this.conn && this.conn.open && this.conn.peer === partnerCode) return this.conn;
    // Läuft schon ein Verbindungsversuch zu diesem Partner (< 10 s)? Dann nicht noch einen starten.
    if (this._connAt && this._connTo === partnerCode && Date.now() - this._connAt < 10000) return null;
    this._connAt = Date.now();
    this._connTo = partnerCode;

    const conn = this.peer.connect(partnerCode, {
      metadata: { from: this.code, fromName: this.userName },
      reliable: true,
    });

    this.handleConnection(conn);
    return conn;
  }

  send(text, ts = Date.now()) {
    if (!this.conn || !this.conn.open) {
      console.warn("[WebRTC] Kein offener Datenkanal");
      return false;
    }

    this.conn.send({
      type: "MESSAGE",
      text,
      fromName: this.userName,
      ts,
    });
    return true;
  }

  isConnected() {
    return this.conn && this.conn.open;
  }
  isPeerReady() {
    return this.peerReady;
  }
  getRoomId() {
    return this.room;
  }

  cleanup() {
    if (this.conn) {
      try {
        this.conn.close();
      } catch {}
      this.conn = null;
    }
  }

  destroy() {
    this.isDestroyed = true;
    this.cleanup();
    if (this.peer && !this.peer.destroyed) {
      this.peer.destroy();
    }
    this.peer = null;
    this.peerReady = false;
    this.reconnectAttempts = 0;
  }
};
