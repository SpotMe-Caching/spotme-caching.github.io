package io.github.spotmecaching.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Brücke zwischen dem Messenger (Web) und dem Hintergrund-Dienst. */
@CapacitorPlugin(name = "SpotMeBackground")
public class SpotMeBackgroundPlugin extends Plugin {

  private SharedPreferences sp() {
    return getContext().getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
  }

  @Override protected void handleOnResume() { PushService.appVisible = true; }
  @Override protected void handleOnPause() { PushService.appVisible = false; }

  @PluginMethod
  public void start(PluginCall call) {
    String code = call.getString("code", "");
    String token = call.getString("token", "");
    String api = call.getString("api", "");
    if (code.isEmpty() || token.isEmpty() || !api.startsWith("https://")) { call.reject("Daten fehlen"); return; }
    SharedPreferences.Editor e = sp().edit();
    boolean newUser = !code.equals(sp().getString("code", ""));
    e.putString("code", code).putString("token", token).putString("api", api).putBoolean("enabled", true);
    if (newUser) e.putLong("after", -1);
    e.apply();
    try { PushService.start(getContext()); call.resolve(status()); }
    catch (Exception ex) { call.reject("Dienst konnte nicht starten: " + ex.getMessage()); }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    sp().edit().putBoolean("enabled", false).apply();
    PushService.stop(getContext());
    call.resolve(status());
  }

  @PluginMethod
  public void getStatus(PluginCall call) { call.resolve(status()); }

  @PluginMethod
  public void openBatterySettings(PluginCall call) {
    try {
      Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
    } catch (Exception ex) { openAppSettingsInternal(); }
    call.resolve();
  }

  @PluginMethod
  public void openAppSettings(PluginCall call) { openAppSettingsInternal(); call.resolve(); }

  private void openAppSettingsInternal() {
    Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(i);
  }

  private JSObject status() {
    JSObject o = new JSObject();
    o.put("enabled", sp().getBoolean("enabled", false));
    o.put("running", PushService.running);
    boolean ex = true;
    if (Build.VERSION.SDK_INT >= 23) {
      PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
      ex = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }
    o.put("batteryExempt", ex);
    return o;
  }
}
