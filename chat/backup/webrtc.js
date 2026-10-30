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
    this.onConnect = null;
    this.onDisconnect = null;
    this.onError = null;
    this.onPeerReady = null;

    this.reconnectAttempts = 0;
    this.MAX_RECONNECT = 5;
    this.isDestroyed = false; // Sicherheitsflag
  }

  register() {
    console.log("[WebRTC] Registriere Peer mit ID:", this.code);
    this.isDestroyed = false;

    // Falls noch ein Peer existiert, hart zerstören
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch (e) {}
      this.peer = null;
    }

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
      this.reconnectAttempts = 0;
      if (this.onPeerReady) this.onPeerReady(id);
    });

    this.peer.on("connection", (conn) => {
      console.log("[WebRTC] Eingehende Verbindung von:", conn.peer);
      this.handleConnection(conn);
    });

    // ── FEHLERBEHANDLUNG FIX ──────────────────────────────────────────────
    this.peer.on("error", (err) => {
      console.error("[WebRTC] Peer Error:", err.type, err);

      // 1. ID bereits vergeben → Abwarten, bis der alte Eintrag auf dem Server stirbt
      if (err.type === "unavailable-id") {
        console.warn(
          "[WebRTC] ID bereits vergeben. Warte 5s für Server-Cleanup...",
        );
        this.peerReady = false;

        // Alten Peer hart zerstören
        if (this.peer && !this.peer.destroyed) this.peer.destroy();
        this.peer = null;

        setTimeout(() => {
          if (!this.isDestroyed) {
            console.log("[WebRTC] Führe erneute Registrierung durch...");
            this.register();
          }
        }, 5000); // ⬅️ 5 Sekunden warten (lässt den Server die alte Socket-ID vergessen)
        return;
      }

      // 2. Server nicht erreichbar → Reconnect-Logik
      if (err.type === "network" || err.type === "server-error") {
        console.warn("[WebRTC] Server nicht erreichbar. Versuche Reconnect...");
        this.tryReconnect();
        return;
      }

      // 3. Partner nicht online (kein Fehler, einfach ignorieren)
      if (err.type === "peer-unavailable") {
        if (this.onError) this.onError(err);
        return;
      }

      // Alle anderen Fehler weiterreichen
      if (this.onError) this.onError(err);
    });

    this.peer.on("disconnected", () => {
      console.warn("[WebRTC] Peer disconnected vom Server");
      this.peerReady = false;
      if (!this.peer.destroyed) {
        this.peer.reconnect();
      }
    });

    this.peer.on("close", () => {
      console.log("[WebRTC] Peer geschlossen");
      this.peerReady = false;
    });
  }

  tryReconnect() {
    if (this.isDestroyed) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT) {
      console.error("[WebRTC] Max Reconnect-Versuche erreicht");
      if (this.onError) {
        this.onError(
          new Error(
            "Maximale Reconnect-Versuche erreicht. Bitte Seite neu laden.",
          ),
        );
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = 2000 * this.reconnectAttempts;

    console.log(
      `[WebRTC] Reconnect in ${delay}ms (Versuch ${this.reconnectAttempts}/${this.MAX_RECONNECT})`,
    );

    setTimeout(() => {
      if (!this.isDestroyed) {
        this.register();
      }
    }, delay);
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
      if (this.onMessage && data.type === "MESSAGE") {
        this.onMessage({
          text: data.text,
          from: conn.peer,
          fromName: data.fromName,
          ts: data.ts || Date.now(),
        });
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

  initiateConnection(partnerCode) {
    if (!this.peer || !this.peerReady) {
      console.error("[WebRTC] Peer nicht bereit für initiateConnection");
      return null;
    }

    const conn = this.peer.connect(partnerCode, {
      metadata: { from: this.code, fromName: this.userName },
      reliable: true,
    });

    this.handleConnection(conn);
    return conn;
  }

  send(text) {
    if (!this.conn || !this.conn.open) {
      console.warn("[WebRTC] Kein offener Datenkanal");
      return false;
    }

    this.conn.send({
      type: "MESSAGE",
      text,
      fromName: this.userName,
      ts: Date.now(),
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
