package io.github.spotmecaching.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SpotMeBackgroundPlugin.class);
    super.onCreate(savedInstanceState);
    String[] wanted = Build.VERSION.SDK_INT >= 33
      ? new String[] { Manifest.permission.POST_NOTIFICATIONS }
      : new String[] {};
    ArrayList<String> need = new ArrayList<>();
    for (String p : wanted) {
      if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
        need.add(p);
      }
    }
    if (!need.isEmpty()) {
      ActivityCompat.requestPermissions(this, need.toArray(new String[0]), 4711);
    }
  }
}
