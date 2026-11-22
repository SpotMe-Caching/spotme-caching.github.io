#!/usr/bin/env python3
"""Baut Hintergrund-Verbindung (Push ohne Google) in das von Capacitor erzeugte Android-Projekt ein.
Aufruf (in android-app/): python3 native/install_native.py"""
import os, re, shutil, sys
base = os.path.dirname(os.path.abspath(__file__))
proj = os.path.join(os.path.dirname(base), "android", "app", "src", "main")
man = os.path.join(proj, "AndroidManifest.xml")
jdir = os.path.join(proj, "java", "io", "github", "spotmecaching", "app")
os.makedirs(jdir, exist_ok=True)
for f in ("PushService.java", "BootReceiver.java", "SpotMeBackgroundPlugin.java", "MainActivity.java"):
    shutil.copy(os.path.join(base, f), os.path.join(jdir, f))
s = open(man, encoding="utf-8").read()
assert "</application>" in s and "</manifest>" in s, "Manifest unerwartet"
if "PushService" not in s:
    comp = '''
        <service android:name=".PushService" android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="messenger_connection" />
        </service>
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
    '''
    s = s.replace("</application>", comp + "</application>", 1)
for p in ("FOREGROUND_SERVICE", "FOREGROUND_SERVICE_SPECIAL_USE", "RECEIVE_BOOT_COMPLETED", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"):
    tag = f'android.permission.{p}"'
    if tag not in s:
        s = s.replace("</manifest>", f'    <uses-permission android:name="android.permission.{p}" />\n</manifest>', 1)
open(man, "w", encoding="utf-8").write(s)
print("Hintergrund-Verbindung eingebaut")
