package io.github.spotmecaching.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Startet die Hintergrund-Verbindung nach dem Neustart, wenn der Nutzer sie eingeschaltet hat. */
public class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && PushService.enabled(context)) {
      try { PushService.start(context); } catch (Exception ignored) {}
    }
  }
}
