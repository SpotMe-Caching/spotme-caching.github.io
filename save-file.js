// SpotMe · Datei-Speichern in der Android-App (Capacitor)
// Im Android-WebView funktionieren <a download>-Links mit Blob nicht.
// Dieses Skript fängt sie dort ab und öffnet den Teilen-Dialog
// (Speichern in Dateien, Drive, an mich selbst senden ...).
// Im normalen Browser / in der TWA ändert sich nichts.
(function () {
  var blobs = new Map();

  var origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var u = origCreate(obj);
    if (obj instanceof Blob) blobs.set(u, obj);
    return u;
  };

  function isApp() {
    var C = window.Capacitor;
    return !!(C && C.isNativePlatform && C.isNativePlatform());
  }

  async function saveAndShare(blob, name) {
    try {
      var P = window.Capacitor.Plugins;
      var text = await blob.text();
      var res = await P.Filesystem.writeFile({
        path: name, data: text, directory: 'CACHE', encoding: 'utf8'
      });
      await P.Share.share({
        title: name, url: res.uri, dialogTitle: 'Datei speichern'
      });
    } catch (e) {
      var msg = (e && e.message) ? e.message : String(e);
      if (/cancel/i.test(msg)) return;
      alert('Speichern fehlgeschlagen: ' + msg);
    }
  }

  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var blob = this.download && blobs.get(this.href);
    if (blob && isApp()) { saveAndShare(blob, this.download); return; }
    return origClick.call(this);
  };
})();
