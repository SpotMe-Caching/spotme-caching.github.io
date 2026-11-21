package io.github.spotmecaching.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Hält im Hintergrund eine Verbindung zum Messenger-Server (Long-Poll) und zeigt bei neuen
 * Nachrichten eine Benachrichtigung. Kein Google/FCM, keine zweite App.
 * Es wird nichts als gelesen markiert – das macht weiterhin nur der Messenger beim Abholen.
 */
public class PushService extends Service {
  static final String PREFS = "spotme_bg";
  static final String CH_STATUS = "bg_status";
  static final String CH_MSG = "bg_msg";
  static final int ID_STATUS = 4711001;
  /** true, solange die App sichtbar ist – dann zeigt der Messenger selbst alles an. */
  static volatile boolean appVisible = false;
  static volatile boolean running = false;

  private Thread worker;
  private volatile boolean stop = false;

  static boolean enabled(Context c) {
    return c.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false);
  }

  static void start(Context c) {
    Intent i = new Intent(c, PushService.class);
    if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
  }

  static void stop(Context c) {
    c.stopService(new Intent(c, PushService.class));
  }

  @Override public IBinder onBind(Intent intent) { return null; }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    makeChannels();
    Notification n = statusNotification();
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(ID_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    } else {
      startForeground(ID_STATUS, n);
    }
    if (!enabled(this)) { stopSelf(); return START_NOT_STICKY; }
    if (worker == null || !worker.isAlive()) {
      stop = false;
      running = true;
      worker = new Thread(this::loop, "spotme-push");
      worker.start();
    }
    return START_STICKY;
  }

  @Override public void onDestroy() {
    stop = true;
    running = false;
    if (worker != null) worker.interrupt();
    super.onDestroy();
  }

  private void makeChannels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel st = new NotificationChannel(CH_STATUS, "Verbindung im Hintergrund", NotificationManager.IMPORTANCE_MIN);
    st.setDescription("Dauerhafte Mini-Anzeige, damit Android die Verbindung nicht beendet. Kann in den Android-Einstellungen leise/ausgeblendet werden.");
    st.setShowBadge(false);
    nm.createNotificationChannel(st);
    NotificationChannel ms = new NotificationChannel(CH_MSG, "Neue Nachrichten", NotificationManager.IMPORTANCE_HIGH);
    ms.setShowBadge(true);
    nm.createNotificationChannel(ms);
  }

  private PendingIntent openApp() {
    Intent i = new Intent(this, MainActivity.class);
    i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    int f = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
    return PendingIntent.getActivity(this, 0, i, f);
  }

  private Notification statusNotification() {
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_STATUS) : new Notification.Builder(this);
    b.setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle("SpotMe Messenger")
      .setContentText("Bereit für neue Nachrichten")
      .setOngoing(true)
      .setContentIntent(openApp());
    if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_MIN);
    return b.build();
  }

  private void notifyMessage(String from, String name, String text) {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_MSG) : new Notification.Builder(this);
    b.setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(name)
      .setContentText(text)
      .setAutoCancel(true)
      .setContentIntent(openApp());
    if (Build.VERSION.SDK_INT < 26) { b.setPriority(Notification.PRIORITY_HIGH); b.setDefaults(Notification.DEFAULT_ALL); }
    try { nm.notify(from.hashCode(), b.build()); } catch (Exception ignored) {}
  }

  private JSONObject get(String api, String code, String token, long after, boolean nowait) throws Exception {
    String u = api + "/messenger/wait/" + code + "?after=" + after + (nowait ? "&nowait=1" : "");
    HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
    c.setConnectTimeout(15000);
    c.setReadTimeout(40000);
    c.setRequestProperty("x-spotme-token", token);
    try {
      int sc = c.getResponseCode();
      if (sc == 403 || sc == 401) throw new SecurityException("auth");
      if (sc != 200) throw new Exception("http " + sc);
      BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
      StringBuilder sb = new StringBuilder();
      String line;
      while ((line = r.readLine()) != null) sb.append(line);
      return new JSONObject(sb.toString());
    } finally {
      c.disconnect();
    }
  }

  private void loop() {
    SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
    long backoff = 5000;
    while (!stop) {
      try {
        String api = sp.getString("api", "");
        String code = sp.getString("code", "");
        String token = sp.getString("token", "");
        if (api.isEmpty() || code.isEmpty() || token.isEmpty() || !sp.getBoolean("enabled", false)) break;
        long after = sp.getLong("after", -1);
        if (after < 0) { // erster Start: nichts Altes melden, ab jetzt zählen
          JSONObject j = get(api, code, token, 0, true);
          after = j.optLong("last", 0);
          sp.edit().putLong("after", after).apply();
          continue;
        }
        JSONObject j = get(api, code, token, after, false);
        JSONArray items = j.optJSONArray("items");
        if (items != null) {
          for (int i = 0; i < items.length(); i++) {
            JSONObject m = items.getJSONObject(i);
            long id = m.optLong("id", 0);
            if (id > after) after = id;
            if (!appVisible) notifyMessage(m.optString("from"), m.optString("name", "Neue Nachricht"), m.optString("text"));
          }
          sp.edit().putLong("after", after).apply();
        }
        backoff = 5000;
      } catch (SecurityException e) {
        // Zugang ungültig → Dienst abschalten, damit nichts im Kreis läuft
        sp.edit().putBoolean("enabled", false).apply();
        break;
      } catch (InterruptedException e) {
        break;
      } catch (Exception e) {
        try { Thread.sleep(backoff); } catch (InterruptedException ie) { break; }
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    running = false;
    stopSelf();
  }
}
